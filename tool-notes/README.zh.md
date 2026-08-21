# @deepseek-ai/dsh-tool-notes

基于 DeepSeek Harness 事件溯源会话日志的、面向模型的持久便签工具。

这是一个 `dsh` 工具插件，为 agent 提供一块**持久、追加式**的会话便签板：记录它不能丢失的事实、决策与待确认问题，之后可用标签过滤读回。与 `todo_write`（整表替换、每轮清空）不同，便签在整轮会话内跨越 turn 边界持续存在。

## 为什么

长时间运行的 agent 会丢失那些细小却关键的事实——一个 base URL、用户只说过一次的约束、已经做过的决策。反复重新推导浪费 turn 与 token。`note_add` / `note_list` 给模型一块有界的、由它自己控制的显式记忆。

## 工具

### `note_add`

记录一条便签。追加式：便签不会被编辑或删除。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `text` | string | 是 | 便签内容——单条简洁、自包含的事实/决策/问题。 |
| `tags` | string[] | 否 | 可选分组标签，供后续过滤检索（自动 trim、去重、丢弃空项）。 |

返回 `{ id, text, tags, total }` —— `id` 是事件序号，`total` 是追加后的便签总数。

### `note_list`

读回便签，可选按单个精确标签过滤。

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `tag` | string | 否 | 精确过滤用的标签。 |

按追加顺序返回 `{ notes: [{ id, text, tags }], total }`。

## 事件模型

每条便签是一个 `note/add` 会话事件 `{ text, tags }`；事件的 `seq` 即便签的稳定 id。便签是「仅日志」的 UI 状态（永不进入派生历史），因此除非通过 `note_list` 自身的返回，否则不会进入模型上下文。

## 配置

```ts
interface Config {
  /** 单会话便签上限；超过上限的追加会被拒绝。 */
  maxNotes: number
}
```

上限是工具自身的部署策略，有意不做成持久化形状不变式：在上限较宽松时写入的日志，在上限收紧后仍能正常回放。

## 组合

```yaml
- name: '@deepseek-ai/dsh-system-prompt'
- name: '@deepseek-ai/dsh-tools'
- name: '@deepseek-ai/dsh-tool-notes'
  config:
    maxNotes: 100
```

## 不变式伴生插件

`@deepseek-ai/dsh-tool-notes/invariant` 注册 `tool-notes-invariant`，在每条 `note/add` 快照进入持久日志前校验其形状（非空且已 trim 的 `text`、字符串数组 `tags`、无重复）。

## 开发

```sh
pnpm vitest run packages/notes/tool-notes/tests/tool-notes.spec.ts
pnpm exec tsx packages/notes/tool-notes/demo/notes-demo.ts
```
