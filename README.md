# maggot-finance-agent

移动端优先的 H5 个人财务规划 Agent：所有精确资产、交易明细与计算核验保存在浏览器本地加密金库中；服务端与云端模型仅接收经授权、按最少必要信息生成的区间摘要和封闭枚举结构，严禁精确金额与身份标识出域。

区间摘要仍属于财务隐私，数据最小化不保证完全匿名，也不保证无法结合外部信息推断资产。

**开发状态：** 当前为开发中的原型，自动化验证默认使用合成数据和 Mock 模型；不代表真实模型稳定性、手机实机或公网部署已经验收。

## 核心能力与边界

- **本地加密金库**：基于 Web Crypto PBKDF2 + AES-GCM 与 IndexedDB（Dexie）存储加密画像、规划目标、本地账单、运行检查点与验证报告，口令仅保留在运行期内存中；不支持账号找回或跨设备静默同步，提供经口令保护的全量加密备份导出/导入（`.json`）。
- **确定性财务测算引擎**：支持大额支出（`large_purchase`）、收入下降缓冲（`income_reduction`）与储蓄目标（`savings_goal`）测算，支持按日历月展开周/月还款、同项去重、收支日历序与多目标资金池占用扣减。
- **隐私出站网关（PrivacyGateway）与受控对话**：出站前按 `allowedScopes` 最小授权检查，关闭自由文本追问与自由文本澄清，只允许预定义 `FollowUpIntent`、`ClarificationChoice`、`RejectionCategory` 与桶化摘要通过 HTTP + SSE 传至服务端。
- **非投资/交易建议声明**：仅用于个人现金流可行性测算与方案对比，不接入真实银行/券商账户，不构成金融投资建议或收益承诺；使用云端模型时，经授权的脱敏区间摘要会发送至所配置的模型服务商。

## 测算时间口径

可用存款按“资料日期当天结束时点”的余额记录。规划月数包含当月，目标支出安排在最后一个月月末；资料日期及之前已发生的工资、生活费和还款不重复计入。缺少收支日期时只提供月末估算，不给出期间流动性已验证的可行结论。

## 工程结构

- `packages/contracts`：前后端共享 Zod Schema、脱敏摘要协议、SSE 事件与防 XSS 净化工具
- `apps/server`：Node.js Fastify API、SSE 会话状态机（`AgentSession` / `SessionStore`）、限流与披露预算防护、`MockModelProvider` 与 `OpenAIModelProvider`
- `apps/web`：Vue 3 + Vite + Vant H5 前端、Pinia 状态管理、本地财务规则与计算器、PrivacyGateway、AES-GCM Vault
- `scripts`：命令行会话运行器（`cli-agent.mjs`）与合成样本评测脚本（`batch-cloud-eval.mjs`）
- `e2e`：基于 Playwright（运行在 `FORCE_MOCK=true` 合成模拟模式下）的 H5 端到端测试

## 环境准备

- Node.js `>= 24.0.0`
- pnpm `10.x`

安装依赖：

```bash
pnpm install
```

可选环境变量（复制 `.env.example` 为 `.env.local`，仅在本地服务端进程读取，浏览器构建产物不包含任何 API Key）：

```env
# 留空或设置 FORCE_MOCK=true 时使用本地离线 Mock Provider
FORCE_MOCK=true
# 可选：启用真实 OpenAI 兼容模型服务端点
# OPENAI_API_KEY=...
# OPENAI_BASE_URL=https://api.openai.com/v1
# OPENAI_MODEL=gpt-4o-mini
```

## 开发与验证命令

```bash
# 类型检查与构建
pnpm typecheck
pnpm lint
pnpm build

# 启动前后端开发服务（Vite + Fastify）
pnpm dev

# 运行全量单元与集成测试（强制 Mock 模式，不发起外部计费调用）
FORCE_MOCK=true pnpm test

# 运行合成样本批量评测（Mock 模式）
pnpm eval:mock

# 运行浏览器端到端测试（首次需执行 pnpm exec playwright install chromium）
pnpm test:e2e

# 运行命令行交互模式（默认支持 Mock / 可选配置模型）
pnpm cli -- --provider mock --non-interactive
```

## 开源仓库与本地资料

仓库包含运行所需源码、依赖锁文件、合成测试、CI 配置和空白环境模板。真实环境配置、个人财务数据、加密备份、运行日志、内部工作文档和评估输出仅留在本地，不应提交。请在受支持的 Node.js 环境中使用 `pnpm install --frozen-lockfile` 复现依赖。

## 许可协议

[MIT](./LICENSE)
