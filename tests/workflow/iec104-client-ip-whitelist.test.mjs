import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const pageSource = readFileSync(new URL('../../src/pages/IEC104/index.tsx', import.meta.url), 'utf8');
const rustCommandSource = readFileSync(
  new URL('../../src-tauri/src/commands/iec104.rs', import.meta.url),
  'utf8',
);

const formStart = pageSource.indexOf('<Form\n          form={linkForm}');
const formEnd = pageSource.indexOf('</Form>', formStart);
const linkFormSource = pageSource.slice(formStart, formEnd);

const getEndpointFieldSource = (name) => {
  const fieldIndex = linkFormSource.indexOf(`name="${name}"`);
  const fieldStart = linkFormSource.lastIndexOf('<Col', fieldIndex);
  const fieldEnd = linkFormSource.indexOf('</Col>', fieldIndex);
  return linkFormSource.slice(fieldStart, fieldEnd);
};

const remoteIpFieldSource = getEndpointFieldSource('remote_ip');
const remotePortFieldSource = getEndpointFieldSource('remote_port');

const optionalIpv4Start = pageSource.indexOf('const validateOptionalIpv4');
const optionalIpv4End = pageSource.indexOf('type DataBusConnectionOption', optionalIpv4Start);
const optionalIpv4Source = pageSource.slice(optionalIpv4Start, optionalIpv4End);

const roleChangeStart = pageSource.indexOf('const handleLinkFormValuesChange = useCallback');
const roleChangeEnd = pageSource.indexOf('const handleLinkSubmit = useCallback', roleChangeStart);
const roleChangeSource = pageSource.slice(roleChangeStart, roleChangeEnd);

const submitStart = pageSource.indexOf('const handleLinkSubmit = useCallback');
const submitEnd = pageSource.indexOf('const handleDeleteLink = useCallback', submitStart);
const submitSource = pageSource.slice(submitStart, submitEnd);

// 验证 ROLE_SERVER 显示允许的主站 IP，并使用允许空值的 IPv4 校验。
test('IEC104 服务端显示并校验可选主站 client IP', () => {
  assert.ok(formStart >= 0 && formEnd > formStart, '未找到 IEC104 链路表单');
  assert.match(remoteIpFieldSource, /name="remote_ip"/);
  assert.match(remoteIpFieldSource, /ROLE_SERVER[\s\S]*允许的主站 IP|允许的主站 IP[\s\S]*ROLE_SERVER/);
  assert.doesNotMatch(remoteIpFieldSource, /showRemoteEndpointFields/);
  assert.match(remoteIpFieldSource, /validator:\s*validateOptionalIpv4/);
  assert.match(optionalIpv4Source, /value\.trim\(\) === ''[\s\S]*Promise\.resolve\(\)/);
});

// 验证 ROLE_SERVER 切换时保留主站 IP、清空无意义的远端端口，且表单不显示远端端口。
test('IEC104 服务端仅保留主站 IP 而不使用 remote port', () => {
  assert.ok(roleChangeStart >= 0 && roleChangeEnd > roleChangeStart, '未找到 IEC104 role 切换处理器');
  const serverBranchStart = roleChangeSource.indexOf('if (role === ROLE_SERVER)');
  const clientBranchStart = roleChangeSource.indexOf('if (role === ROLE_CLIENT)', serverBranchStart);
  const serverBranch = roleChangeSource.slice(serverBranchStart, clientBranchStart);

  assert.ok(serverBranchStart >= 0 && clientBranchStart > serverBranchStart, '未找到 ROLE_SERVER 切换分支');
  assert.doesNotMatch(serverBranch, /remote_ip\s*=/);
  assert.match(serverBranch, /remote_port\s*=\s*undefined/);

  const visibilityMatch = pageSource.match(
    /const\s+(\w*[Rr]emote\w*[Pp]ort\w*)\s*=\s*([^;]+);/,
  );
  const visibilityVariable = visibilityMatch?.[1];
  const visibilityExpression = visibilityMatch?.[2] ?? '';
  const usesDirectRoleCheck = /display:\s*linkRole\s*===\s*ROLE_CLIENT\s*\?\s*undefined\s*:\s*'none'/
    .test(remotePortFieldSource)
    || /display:\s*linkRole\s*!==\s*ROLE_SERVER\s*\?\s*undefined\s*:\s*'none'/
      .test(remotePortFieldSource);
  const usesClientOnlyVariable = visibilityVariable
    ? new RegExp(`display:\\s*${visibilityVariable}`).test(remotePortFieldSource)
      && (/linkRole\s*===\s*ROLE_CLIENT/.test(visibilityExpression)
        || /linkRole\s*!==\s*ROLE_SERVER/.test(visibilityExpression))
    : false;
  assert.ok(usesDirectRoleCheck || usesClientOnlyVariable, 'ROLE_SERVER 不应显示 remote_port');
});

// 验证 ROLE_SERVER 显式下发主站 IP 白名单，ROLE_CLIENT 仍下发必填远端 IP 和端口。
test('IEC104 按传输角色构造 remote endpoint', () => {
  assert.ok(submitStart >= 0 && submitEnd > submitStart, '未找到 IEC104 链路提交处理器');
  assert.match(
    submitSource,
    /remote:\s*isServerRole\s*\?\s*\{\s*ip:\s*remoteIp,\s*port:\s*0\s*\}/,
  );
  assert.match(
    submitSource,
    /:\s*remoteIp\s*\?\s*\{\s*ip:\s*remoteIp,\s*port:\s*values\.remote_port\s*\?\?\s*DEFAULT_IEC104_PORT\s*\}\s*:\s*null/,
  );
  assert.match(remoteIpFieldSource, /ROLE_CLIENT[\s\S]*required:\s*true|required:\s*true[\s\S]*ROLE_CLIENT/);
  assert.match(submitSource, /local:\s*isClientRole\s*\?\s*null/);
  assert.match(submitSource, /api\.iec104UpsertLink\(config, createOnly\)/);
  assert.match(rustCommandSource, /remote:\s*self\.remote\.as_ref\(\)\.map\(\|endpoint\| endpoint\.to_proto\(\)\)/);
  assert.match(rustCommandSource, /\.upsert_link\(config\.to_proto\(\), create_only\)/);
});
