# Gemini thought_signature「missing」400 错误的真正根因与修复（2026-10-28）

> 结论先行：**问题既不在网关的签名读取，也不在 keypool 插件，而在「签名存放位置」与「客户端 wire 是否透传」的错配。**
> 最终解：网关把签名**藏进 `tool_call.arguments` 的保留键 `__thought_signature`**，下一轮再解出来。
> 修复 commit：`a4e65d8`（线上已验证）。本文记录完整排错过程，含多个错误方向，供以后避免重犯。

> **📎 这是网关仓库内的副本**（随代码一起提交，方便对着 `src/worker.mjs` 读）。
> **权威版在 notes**：`{{WS}}/notes/线路/gemini网关/gemini-thought-signature修复_20261028.md`
> 两份内容一致；**修订以 notes 权威版为先**，改完再同步回本副本。
>
> **📎 上游主文档**：`{{WS}}/render-gemini-proxy.md`（部署全流程 + 全部踩坑；本文是它
> §10.70 之后新增的独立深挖记录。）

---

## 一、错误现象

DSH（DSHA 安卓端）调用 Gemini 网关，**首轮工具调用正常**，**第二轮必失败**：

```
request rejected (HTTP 400): Function call is missing a thought_signature in functionCall parts.
This is required for tools to work correctly...
Additional data, function call `default_api:skill`, position 6.
```

出现频率：每轮工具调用都失败，无论新建对话、重启 DSH、更新插件版本。

---

## 二、Google 官方规则（关键背景）

来源：`https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures`

1. **Gemini 4 / 3 强制校验**：当前轮次（current turn）内所有 functionCall 步骤，**第一个 functionCall part 必须带签名**，否则 400。
2. **只校验当前轮**，更早的历史轮次不校验。
3. **并行调用**：只有**第一个** functionCall 带签名，后续不带。
4. **顺序调用（multi-step）**：每一步的第一个 functionCall 都要带。
5. 签名是加密串，**不能伪造、不能改写**，必须原样回传。
6. 官方提供的**跳过校验 dummy 值**：`"skip_thought_signature_validator"` / `"context_engineering_is_the_way_to_go"`。
7. **签名位置**：Google 原生 API 放在 **`part.thoughtSignature`（part 层级）**，**不在 `functionCall` 内部**。

---

## 三、真正的根因（三层，逐层剥离）

### 层 1：网关响应侧读错字段（已修）

Google 把签名放在 `part.thoughtSignature`，而网关代码读的是 `fc.thoughtSignature`（`functionCall` 内部）：

```js
// 错误
const thought_signature = fc.thoughtSignature;
// 正确
const thought_signature = part.thoughtSignature ?? fc.thoughtSignature;
```

**后果**：首轮响应**从来不带** `extra_content.google.thought_signature`。
**证据**：修复前反复 curl 首轮，响应 `tool_calls` 里始终没有 `extra_content`。

commit：`bf1ec55`

### 层 2：签名放错层级（我引入的错误，已回退）

中途依据 gemini-cli issue #28697，把签名改成放进 `functionCall.thought_signature`（snake_case）。**这是错的** —— Google 直接报：

```
Unknown name "thought_signature" at 'contents[1].parts[0].function_call': Cannot find field.
```

正确位置是 `part.thoughtSignature`（与 `functionCall` 同级）。

> ⚠️ 教训：`gemini-cli` 那个 issue 修的是**它自己合成签名**的场景，与「Google 真实返回签名的位置」不是一回事，不可直接照搬。

### 层 3：客户端 wire 根本不透传 `extra_content`（**核心原因**）

这是真正的死穴。DSH 用的是 **pi-ai 的 `openai-completions` wire**，而：

| pi-ai 文件 | 是否处理 `thoughtSignature` |
|---|---|
| `dist/api/google-generative-ai.js` | ✅ 完整支持（第 98/108/148 行） |
| `dist/api/openai-completions.js` | ❌ **不解析 `extra_content`**（仅在 981 行处理 reasoning details） |

**会话日志的硬证据**（解压 `session-0f753e90`，2846 条记录）：

| 指标 | 数值 |
|---|---|
| assistant 消息总数 | 413 |
| **带 `replayState` 的消息** | **0** |
| **tool-call 块字段组合** | **370 个全部是 `{type,id,name,arguments}`** |

即：网关返回的签名，**在 DSH 内核层被丢得一干二净**，历史里根本没有可回传的东西。

---

## 四、最终方案：签名内嵌进 `arguments`

### 为什么可行

`arguments` 是**任何 OpenAI 兼容客户端（包括 pi-ai）唯一必然原样回传**的字段。
`extra_content` 会被丢，`id` 可能被重新生成，但 `arguments` 一定完整往返。

### 实现（网关两侧，共约 21 行）

**响应侧**（`transformCandidates`）——签名塞进 arguments：

```js
const SIGNATURE_KEY = "__thought_signature";
const argsOut = thought_signature
  ? { ...fc.args, [SIGNATURE_KEY]: thought_signature }
  : fc.args;
message.tool_calls.push({
  id: fc.id ?? "call_" + generateId(),
  type: "function",
  function: { name: fc.name, arguments: JSON.stringify(argsOut) },
  extra_content: thought_signature ? {google: { thought_signature }} : undefined,
});
```

**请求侧**（`transformFnCalls`）——解出并放回 part 层级：

```js
const SIGNATURE_KEY = "__thought_signature";
let smuggled;
if (args && typeof args === "object" && !Array.isArray(args) && SIGNATURE_KEY in args) {
  smuggled = args[SIGNATURE_KEY];
  delete args[SIGNATURE_KEY];        // 模型绝不能看到这个保留键
}
const out = { functionCall: { id, name, args } };
const sig = smuggled ?? tc?.google?.thought_signature ?? msgSig;
if (sig) { out.thoughtSignature = sig; }   // ✅ part 层级
```

同时保留 `extra_content`，让**支持它的客户端**（如 Cline）走原生路径，两条路都通。

---

## 五、验证结果（线上实测）

| 测试 | 结果 |
|---|---|
| 首轮响应 | `arguments` 含 `{"x":"hello","__thought_signature":"..."}`，原始参数完整 ✅ |
| 二轮（**模拟 pi-ai：只回传 id/name/arguments，无 extra_content**） | Google 接受，返回正常回答 ✅ |
| 本地编解码单测 | 签名透传成功、参数解出干净 ✅ |
| 连续 5 次请求 | 全部 HTTP 200 ✅ |

---

## 六、过程中走过的错误方向（务必避免重犯）

| # | 错误判断 | 实际 | 代价 |
|---|---|---|---|
| 1 | 改 keypool 插件（sse/adapter/projection 加缓存+注入，+170 行） | 插件不是问题所在 | 白改，已全部回滚为 1.17.0 原版 |
| 2 | 改 DSH 内核 `dsh-llm-pi-ai`（`foreignAssistant` 加 `extra_content` 读取） | 走的是插件+网关链路，用不上 | 已还原；`node_modules` 升级即覆盖 |
| 3 | 相信 gemini-cli issue #28697，把签名放进 `functionCall` 内部 | 位置错，导致 `Cannot find field` | 白折腾数轮 |
| 4 | 用 `sed` 批量改 `worker.mjs` | 破坏 if-else 结构 → 语法错误 | 推出 `29e28fc` 使 **Render 部署失败** |
| 5 | 反复 `pkill -9` + 重启 DSH Web | 导致用户端多次崩溃 | 用户体验严重受损 |
| 6 | 只看代码猜、不解压会话日志 | **最致命**：真实数据结构一开始就能定位问题 | 多轮无效修改 |

**核心教训：先拿证据（解压会话日志看真实字段），再动代码。** 第 6 条若第一步就做，一行代码即可收工。

---

## 七、附带发现：403「Blocked」

排错后期出现：

```
API key rejected by provider (HTTP 403): <!DOCTYPE html>...<title>Blocked</title>
```

特征：HTML 页、字体 Roobert —— 是 **Render 边缘的 Blocked 页**，非 Google、非网关代码。

**原因**：该时段正推送 `4511b0d` 触发 Render 重新部署，部署窗口内 Render 返回 Blocked。日志里 `errorCount: 6` 正是这 6 次失败。

**验证**：部署完成后连续 5 次请求全部 200；手机浏览器打开 `/v1/models` 返回正常 JSON。

**结论**：推送新 commit 后需等部署完成（1–2 分钟）再测，否则会误判成 key / 网关故障。

---

## 八、当前最终状态

| 组件 | 状态 |
|---|---|
| **网关** `openai-gemini-fork` `src/worker.mjs` | ✅ `a4e65d8` 已部署，签名内嵌方案生效 |
| **keypool 插件** `/root/.dsh/plugin-src/` | ✅ 回滚为干净 1.17.0 原版（零调试代码） |
| **DSH 内核** `dsh-llm-pi-ai` | ✅ 已还原（`extra_content` 残留已清除，备份 `/tmp/dsh-llm-pi-ai.bak.js`） |

---

## 九、推送备忘

本机 `git push` 直连 `github.com:443` 经常超时，可改走 **GitHub REST API**（见 `render-gemini-proxy.md` §10.71）：

1. `GET /git/ref/heads/main` 取当前头
2. `POST /git/blobs`（base64 上传 worker.mjs）
3. `POST /git/trees` 重建 `src` 子树（换 worker.mjs 条目）
4. `POST /git/trees` 重建根树（换 src 条目）
5. `POST /git/commits`（parents = 远端头）
6. `PATCH /git/refs/heads/main`

脚本见 `.agents/skills/dsh-session-query/`(同目录 `decode.mjs` 思路)。推送可用 `tools/git-push-api.mjs`（见下 §十一）。PAT 在 `.agents/skills/apk-decompile-gh/pat.txt`。

---

## 十、会话日志解压方法（本次关键工具）

DSH 会话日志为**多帧 zstd**，`zstd` 命令在本机不可用，且单次 `zstdDecompressSync` 只解第一帧。
正确做法：按 `28 b5 2f fd` 魔数逐帧定位并解压。**已封装为 skill**：`dsh-session-query`（`.agents/skills/dsh-session-query/decode.mjs`），直接用：

```bash
node {{WS}}/.agents/skills/dsh-session-query/decode.mjs \\
  /root/.dsh/sessions/--sdcard-deep--/<session-id>/session.v4.jsonl.zstd > /tmp/s.jsonl
```

**这是本次能定位到「签名根本没存下来」的关键手段，排查此类问题应第一步就做。**

---

## 十一、GitHub 推送脚本（归档版）

`/tmp` 会在重启后丢失，推送脚本已归档到 **`tools/git-push-api.mjs`**（工作区根下）。
用法：`node {{WS}}/tools/git-push-api.mjs <仓库本地路径>`，自动读 PAT、重建子树、推送。

它会做：取远端头 → 上传改动文件 blob → 重建 `src`/根树 → 建 commit → PATCH ref。
适用 `git push` 直连 443 被墙的情况（本机常见）。
