# 开源发布检查清单

这个清单用于正式公开仓库前的最后确认。

## 必备文件

- [x] `README.md`
- [x] `LICENSE`
- [x] `CONTRIBUTING.md`
- [x] `CODE_OF_CONDUCT.md`
- [x] `SECURITY.md`
- [x] `CHANGELOG.md`
- [x] issue 模板
- [x] pull request 模板

## 元信息

- [x] `package.json` 包含描述、作者和许可证。
- [x] `src-tauri/Cargo.toml` 包含描述、作者和许可证。
- [ ] 确认最终开源仓库地址，并在 `package.json`、`Cargo.toml` 或 README 中补充 repository 链接。
- [ ] 确认应用名称、包名和图标是否为最终品牌。

## 许可证与第三方资源

- [x] 使用 MIT License。
- [ ] 检查所有图标、字体、图片和文案是否允许再分发。
- [ ] 如继续内置第三方资源，补充来源和许可证说明。

## 安全与隐私

- [ ] 搜索仓库，确认没有真实服务器、用户名、密码、私钥、token、日志或本地路径。
- [ ] 评估本地密码/私钥存储方案是否需要改为系统钥匙串。
- [ ] 确认 Tauri capability、文件系统权限和 CSP 策略符合预期。
- [ ] 准备安全漏洞私下报告渠道。

## 构建与发布

- [ ] 在目标平台运行 `pnpm build`。
- [ ] 在目标平台运行 `pnpm tauri build`。
- [ ] 准备 release notes 和安装包签名策略。
- [ ] 确认 CI、自动构建和 release 流程。

## 社区运营

- [ ] 设置 issue labels。
- [ ] 设置默认分支保护规则。
- [ ] 写清 roadmap 或近期不接受的功能范围。
- [ ] 明确维护者响应节奏和支持边界。
