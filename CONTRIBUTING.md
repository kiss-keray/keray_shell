# 贡献指南

感谢你愿意参与 Keray Shell Rust。这个项目还在早期阶段，欢迎通过问题反馈、复现用例、文档改进和代码提交一起把它打磨得更稳。

## 开始之前

- 搜索已有 issue，避免重复提交。
- 对较大的功能改动，建议先开 issue 说明目标、交互和实现思路。
- 不要提交真实服务器地址、密码、私钥、token 或本地配置文件。
- 保持改动聚焦，一次 pull request 尽量只解决一个问题。

## 本地开发

```bash
pnpm install
pnpm tauri dev
```

常用检查：

```bash
pnpm build
pnpm lint
```

如果只改 Rust 代码，也建议在 `src-tauri` 下运行：

```bash
cargo check
```

## 提交规范

提交信息建议使用简洁的英文或中文动词开头，例如：

```text
fix: 修复 SFTP 目录刷新问题
feat: 添加服务器配置导入入口
docs: 补充本地开发说明
```

常用类型：

- `feat`: 新功能
- `fix`: 修复问题
- `docs`: 文档
- `style`: 样式或格式调整
- `refactor`: 重构
- `test`: 测试
- `chore`: 构建、依赖或维护任务

## Pull Request 要求

- 描述这次改动解决了什么问题。
- 说明主要实现方式和影响范围。
- 附上已运行的检查命令。
- UI 改动请提供截图或录屏。
- 关联相关 issue。

## 代码风格

- 前端遵循现有 Vue 3、Pinia、TypeScript 写法。
- Rust 代码保持模块职责清晰，优先复用已有 Tauri command 和 DTO 结构。
- 避免无关重构、格式化整个仓库或大范围重排。
- 注释只写必要的上下文，不重复代码本身。

## 安全相关改动

涉及 SSH、SFTP、私钥、密码、本地存储、同步接口或权限配置的改动，请在 PR 中单独说明安全影响。发现漏洞请按 [SECURITY.md](SECURITY.md) 处理。
