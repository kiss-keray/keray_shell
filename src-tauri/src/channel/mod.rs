mod pool;

use crate::channel::pool::get_or_create_server_pool;
pub(crate) use crate::channel::pool::ChannelPoolPermit;
use crate::dto::res::Res;
use crate::ssh::{get_server_by_id, ServerModel};
use russh::client::{Handle, Msg};
use russh::keys::{decode_secret_key, ssh_key, Error as KeyError, PrivateKeyWithHashAlg};
use russh::{client, kex, Channel, Preferred};
use std::borrow::Cow;
use std::sync::Arc;
use std::time::Duration;

pub struct Client {}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

// 直接获取独立的Channel
pub async fn server_get_channel(server_id: &str) -> Result<Channel<Msg>, String> {
    let model = match get_server_by_id(server_id).await {
        Some(model) => model,
        None => {
            return Err("服务器不存在".into());
        }
    };
    let (_, channel) = server_model_get_channel(&model).await?;
    Ok(channel)
}

// 通过Channel池子获取Channel
pub async fn server_get_channel_pool(
    server_id: &str,
) -> Result<(Channel<Msg>, Option<ChannelPoolPermit>), String> {
    if get_server_by_id(server_id).await.is_none() {
        return Err("服务器不存在".into());
    }
    let pool = get_or_create_server_pool(server_id).await;

    // 返回的许可必须和 Channel 一起存活；调用方 drop 后对应 Handle 才能再次分配名额。
    let (channel, permit) = pool.acquire_channel().await?;
    Ok((channel, Some(permit)))
}

// 其他服务器获取session
pub async fn server_model_get_channel(
    server: &ServerModel,
) -> Result<(Handle<Client>, Channel<Msg>), String> {
    let handle = match get_handle(&server).await {
        Ok(h) => h,
        Err(e) => return Err(e.msg().clone().unwrap_or("服务器认证失败".into())),
    };
    let channel = match handle.channel_open_session().await {
        Ok(c) => c,
        Err(_) => return Err("服务器连接失败".into()),
    };
    Ok((handle, channel))
}

/// 规范化 PEM（去除 `\r`、首尾空白），避免前端/Windows 换行导致头行匹配失败。
fn normalize_pem(pem: &str) -> String {
    pem.replace('\r', "")
        .lines()
        .map(str::trim)
        .collect::<Vec<_>>()
        .join("\n")
}

fn non_empty_passphrase(passphrase: Option<&str>) -> Option<&str> {
    passphrase.filter(|p| !p.is_empty())
}

/// 解析 OpenSSH 格式私钥（`ssh-keygen` 默认格式）。
fn decode_openssh_private_key(
    pem: &str,
    passphrase: Option<&str>,
) -> Result<ssh_key::PrivateKey, KeyError> {
    let key = ssh_key::PrivateKey::from_openssh(pem)?;
    if key.is_encrypted() {
        let pass = non_empty_passphrase(passphrase).ok_or(KeyError::KeyIsEncrypted)?;
        return Ok(key.decrypt(pass)?);
    }
    Ok(key)
}

/// 解密传统 PEM（Proc-Type + DEK-Info）中 russh 未支持的 DES-EDE3-CBC 加密块。
fn decrypt_legacy_des_rsa_pem(pem: &str, passphrase: &str) -> Result<String, KeyError> {
    use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    use data_encoding::HEXLOWER_PERMISSIVE;
    use des::TdesEde3;

    const DEK_DES: &str = "DEK-Info: DES-EDE3-CBC,";

    let mut iv_hex = None;
    let mut b64 = String::new();
    let mut in_body = false;
    for line in pem.lines() {
        if let Some(rest) = line.strip_prefix(DEK_DES) {
            iv_hex = Some(rest.trim());
            continue;
        }
        if line == "-----BEGIN RSA PRIVATE KEY-----" {
            in_body = true;
            continue;
        }
        if line.starts_with("-----END ") {
            break;
        }
        if in_body
            && line
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=')
        {
            b64.push_str(line);
        }
    }
    let iv_hex = iv_hex.ok_or(KeyError::CouldNotReadKey)?;
    let iv_bytes = HEXLOWER_PERMISSIVE
        .decode(iv_hex.as_bytes())
        .map_err(|_| KeyError::CouldNotReadKey)?;
    if iv_bytes.len() != 8 {
        return Err(KeyError::CouldNotReadKey);
    }
    let mut iv = [0u8; 8];
    iv.copy_from_slice(&iv_bytes);

    let ciphertext = data_encoding::BASE64_MIME
        .decode(b64.as_bytes())
        .map_err(KeyError::Decode)?;

    // OpenSSL 传统 PEM：EVP_BytesToKey(MD5, salt=IV) 导出 24 字节 3DES 密钥，IV 仍用头里的 8 字节。
    let mut derived = Vec::new();
    let mut prev = Vec::new();
    while derived.len() < 24 {
        let mut ctx = md5::Context::new();
        if !prev.is_empty() {
            ctx.consume(&prev);
        }
        ctx.consume(passphrase.as_bytes());
        ctx.consume(&iv);
        prev = ctx.compute().0.to_vec();
        derived.extend_from_slice(&prev);
    }
    let mut key = [0u8; 24];
    key.copy_from_slice(&derived[..24]);

    type TdesCbcDec = cbc::Decryptor<TdesEde3>;
    let cipher = TdesCbcDec::new_from_slices(&key, &iv).map_err(|_| KeyError::CouldNotReadKey)?;
    let mut buf = ciphertext;
    let plain = cipher
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|_| KeyError::CouldNotReadKey)?;

    let body = data_encoding::BASE64_MIME.encode(plain);
    let mut lines = vec!["-----BEGIN RSA PRIVATE KEY-----".to_string()];
    for chunk in body.as_bytes().chunks(64) {
        lines.push(String::from_utf8_lossy(chunk).into_owned());
    }
    lines.push("-----END RSA PRIVATE KEY-----".to_string());
    Ok(lines.join("\n"))
}

/// 若 PEM 为 DES-EDE3-CBC 加密的 RSA 私钥，先解密再交给 russh 解析。
fn preprocess_legacy_encrypted_pem(
    pem: &str,
    passphrase: Option<&str>,
) -> Result<String, KeyError> {
    if !pem.contains("Proc-Type: 4,ENCRYPTED") || !pem.contains("DEK-Info: DES-EDE3-CBC,") {
        return Ok(pem.to_string());
    }
    let pass = non_empty_passphrase(passphrase).ok_or(KeyError::KeyIsEncrypted)?;
    decrypt_legacy_des_rsa_pem(pem, pass)
}

// 服务器原始数据获取handle
async fn get_handle(model: &ServerModel) -> Result<Handle<Client>, Res<()>> {
    let config = client::Config {
        inactivity_timeout: Some(Duration::from_secs(3600)),
        preferred: Preferred {
            kex: Cow::Owned(vec![
                kex::CURVE25519_PRE_RFC_8731,
                kex::EXTENSION_SUPPORT_AS_CLIENT,
            ]),
            ..Default::default()
        },
        ..<_>::default()
    };
    let config = Arc::new(config);
    let sh = Client {};
    let session = client::connect(config, (model.ip().clone(), *model.port()), sh).await;
    if session.is_err() {
        println!("session连接错误:{:?}", session.err());
        return Err(Res::fail_code(1, "网络错误"));
    }
    let mut session = session.unwrap();

    if let Some(key_pem) = model.private_key().as_ref().filter(|k| !k.is_empty()) {
        let passphrase = model.private_key_passphrase().as_deref();
        match decode_private_key(key_pem, passphrase) {
            Ok(key_pair) => {
                let rsa_hash = session
                    .best_supported_rsa_hash()
                    .await
                    .ok()
                    .flatten()
                    .flatten();
                let res = session
                    .authenticate_publickey(
                        model.user(),
                        PrivateKeyWithHashAlg::new(Arc::new(key_pair), rsa_hash),
                    )
                    .await;
                if let Ok(auth) = res {
                    if auth.success() {
                        return Ok(session);
                    }
                }
            }
            Err(e) => {
                println!("私钥解析错误:{:?}", e);
                return Err(Res::fail_code(3, private_key_error_message(&e)));
            }
        }
    }

    let password = model.password().clone().filter(|p| !p.is_empty());
    if let Some(password) = password {
        let res = session.authenticate_password(model.user(), password).await;
        if let Ok(auth) = res {
            if auth.success() {
                return Ok(session);
            }
        }
    }

    Err(Res::fail_code(2, "认证失败"))
}

/// 解析多种 SSH 私钥格式（OpenSSH / PKCS#8 / PKCS#1 / 传统 DES 加密 PEM）。
fn decode_private_key(
    pem: &str,
    passphrase: Option<&str>,
) -> Result<ssh_key::PrivateKey, KeyError> {
    let pem = normalize_pem(pem);
    let passphrase = non_empty_passphrase(passphrase);

    if pem.contains("-----BEGIN OPENSSH PRIVATE KEY-----") {
        return decode_openssh_private_key(&pem, passphrase);
    }

    let pem = preprocess_legacy_encrypted_pem(&pem, passphrase)?;
    decode_secret_key(&pem, passphrase)
}

fn private_key_error_message(err: &KeyError) -> &'static str {
    match err {
        KeyError::KeyIsEncrypted => "私钥已加密，请填写口令",
        _ => "私钥格式错误",
    }
}
