use getset::{Getters, Setters};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Getters, Setters)]
#[getset(get = "pub", set = "pub")]
pub struct Res<T> {
    code: i32,
    data: Option<T>,
    msg: Option<String>,
}
impl<T> Res<T> {
    pub fn of(data: T) -> Res<T> {
        Res {
            code: 200,
            data: Some(data),
            msg: None,
        }
    }

    pub fn ok() -> Res<T> {
        Res {
            code: 200,
            data: None,
            msg: None,
        }
    }

    pub fn fail(msg: impl Into<String>) -> Res<T> {
        Res {
            code: -1,
            data: None,
            msg: Some(msg.into()),
        }
    }

    pub fn fail_code(code: i32, msg: impl Into<String>) -> Res<T> {
        Res {
            code,
            data: None,
            msg: Some(msg.into()),
        }
    }
}
