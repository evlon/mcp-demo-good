#!/usr/bin/env node
/**
 * mcp-demo-good —— 一个"会好好说话"的 MCP 服务。
 *
 * 和 mcp-demo-bad 功能完全一样，只有**文字**不同：
 *   · 工具描述说清：动什么、能不能撤、影响范围
 *   · 成功返回说清：改了哪一项、其他有没有受影响、怎么恢复
 *   · 失败返回说清：哪里错了、用户该怎么做
 *
 * 两个包可以同时装，用工具开关面板切换 —— 现场对比"同一件事，两种问法"。
 *
 * ── 怎么用 ──────────────────────────────────────────────────────────────
 *
 *     npx -y mcp-demo-good
 *
 * 在 DSH 里加一个 MCP 服务：
 *     名称：demo-good
 *     命令：npx
 *     参数：-y mcp-demo-good
 *
 * ── 协议要点 ────────────────────────────────────────────────────────────
 *
 *   · stdio 传输：每个 JSON-RPC 消息一行（NDJSON）
 *   · 必须先 initialize → 再 tools/list
 *   · 工具名会被宿主改写成 mcp__<服务名>__<工具名>
 *
 * stderr 可以随便打日志（stdout 是协议通道，绝不能污染）。
 */
import { createInterface } from 'node:readline';

const PROTOCOL_VERSION = '2026-07-28';
// 宿主实际握手请求的是 2025-11-25。MCP 规定服务端支持就原样回，
// 否则回自己最高的，由客户端决定是否继续。
const SUPPORTED_VERSIONS = new Set(['2025-11-25', '2026-07-28']);

const SERVER_INFO = { name: 'mcp-demo-good', version: '1.0.0' };

/**
 * 三个工具，覆盖三种副作用等级。
 *
 * ── 描述为什么这么写 ──────────────────────────────────────────────────
 * 一个能让人放心的工具描述，必须回答四个问题：
 *   ① 它**动什么**（哪个配置项？发给谁？）
 *   ② 动完**能不能撤**
 *   ③ 会不会**牵连**别的数据
 *   ④ 出错时**怎么办**
 *
 * 下面三条描述就是按这四条写的。mcp-demo-bad 故意不写这些。
 */
const TOOLS = [
  {
    name: 'read_status',
    description:
      '读取当前系统状态快照。只读，不修改任何数据，不影响他人。\n'
      + '返回内容：整体状态、细节级别、采集时间。\n'
      + 'detail=brief 返回摘要（约 3 项），detail=full 返回完整明细（约 20 项）。',
    inputSchema: {
      type: 'object',
      properties: {
        detail: {
          type: 'string',
          enum: ['brief', 'full'],
          description: '详细程度：brief 摘要（默认）/ full 完整明细',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'write_config',
    description:
      '修改一条配置项，立即生效。\n'
      + '**只影响你指定的这一个配置项，不改动其他任何配置。**\n'
      + '旧值会被覆盖，**无法自动回滚**；如需恢复，要重新设置回原值。\n'
      + 'key 写错会新建一条无效配置 —— 调用前请确认 key 名称拼写。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: '要修改的配置项名称，例如 timeout.seconds' },
        value: { type: 'string', description: '新的值，会覆盖原有值' },
      },
      required: ['key', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_report',
    description:
      '把一份报告发送给指定收件人。\n'
      + '**发出后立即送达，无法撤回。**\n'
      + '只发送你指定的这一份，不会代发给其他人，也不会在公共空间存副本。\n'
      + '收件人写错会发给错误的人且无法追回 —— 发送前请核对收件人。',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '收件人账号或邮箱，例如 zhangsan@example.com' },
        body: { type: 'string', description: '报告正文，纯文本' },
      },
      required: ['to', 'body'],
      additionalProperties: false,
    },
  },
];

const log = (...args) => process.stderr.write(`[mcp-demo-good] ${args.join(' ')}\n`);

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });

/**
 * 成功返回。
 *
 * 这里每个字都是有意的：用户看完这段话，应该能回答
 * "它动了什么、别的有没有事、我还能不能退回去"。
 */
function successText(name, args) {
  switch (name) {
    case 'read_status':
      return `系统状态：正常。\n`
        + `- 细节级别：${args.detail ?? 'brief'}\n`
        + `- 条目数：${args.detail === 'full' ? 20 : 3}\n`
        + `- 采集时间：${new Date().toISOString()}\n`
        + `未修改任何数据。`;
    case 'write_config':
      return `已修改配置项「${args.key}」\n`
        + `- 新值：${args.value}（立即生效）\n`
        + `- 原值已被覆盖，**无法自动恢复**；如需恢复请重新设置回原值\n`
        + `- 其他配置项未受影响`;
    case 'send_report':
      return `已发送给「${args.to}」\n`
        + `- 正文长度：${String(args.body ?? '').length} 字\n`
        + `- 发送后**无法撤回**，请留意对方回复\n`
        + `（这是演示服务，消息未真正发出。）`;
    default:
      return `已执行 ${name}`;
  }
}

/**
 * 失败返回。
 *
 * 这条是课程里「拒绝时给下一步」的直接体现：
 * 不只说"失败了"，而是说清**哪里错、该怎么办**。
 */
function errorText(reason) {
  switch (reason) {
    case 'missing-key':
      return '缺少参数：write_config 需要 key 和 value 两个参数。\n'
        + '请确认调用时都带上，例如 key="timeout.seconds"、value="60"，然后重试。';
    case 'missing-to':
      return '缺少收件人：send_report 需要 to 和 body 两个参数。\n'
        + '请确认收件人账号（如 zhangsan@example.com）后重试。';
    case 'invalid-detail':
      return 'detail 只能是 brief 或 full。收到的是其他值，请改正后重试。';
    default:
      return '参数不正确，请检查后重试。';
  }
}

function handleToolsCall(id, params) {
  const name = String(params?.name ?? '');
  const args = params?.arguments ?? {};
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    ok(id, {
      isError: true,
      content: [{
        type: 'text',
        text: `没有这个工具：${name}\n可用工具：${TOOLS.map((t) => t.name).join('、')}`,
      }],
    });
    return;
  }
  log(`call ${name} args=${JSON.stringify(args)}`);

  switch (name) {
    case 'read_status':
      if (args.detail !== undefined && args.detail !== 'brief' && args.detail !== 'full') {
        ok(id, { isError: true, content: [{ type: 'text', text: errorText('invalid-detail') }] });
        return;
      }
      break;
    case 'write_config':
      if (typeof args.key !== 'string' || typeof args.value !== 'string') {
        ok(id, { isError: true, content: [{ type: 'text', text: errorText('missing-key') }] });
        return;
      }
      break;
    case 'send_report':
      if (typeof args.to !== 'string' || typeof args.body !== 'string') {
        ok(id, { isError: true, content: [{ type: 'text', text: errorText('missing-to') }] });
        return;
      }
      break;
    default:
      break;
  }

  ok(id, { content: [{ type: 'text', text: successText(name, args) }] });
}

function dispatch(message) {
  const { id, method, params } = message ?? {};
  if (id === undefined || id === null) {
    log(`notification: ${method}`);
    return;
  }
  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const agreed = SUPPORTED_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION;
      log(`initialize: client requested ${requested}, agreed ${agreed}`);
      ok(id, {
        protocolVersion: agreed,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    }
    case 'ping':
      ok(id, {});
      return;
    case 'tools/list':
      ok(id, { tools: TOOLS });
      return;
    case 'tools/call':
      handleToolsCall(id, params);
      return;
    default:
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (text === '') return;
  let message;
  try {
    message = JSON.parse(text);
  } catch (error) {
    log(`bad json: ${String(error)}`);
    return;
  }
  try {
    dispatch(message);
  } catch (error) {
    log(`dispatch error: ${String(error)}`);
  }
});

log('started (good)');