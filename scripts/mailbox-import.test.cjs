const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parse } = require('../static/mailbox-import.js');

const email = 'someone@outlook.com';
const password = 'Secret123!';
const clientID = '12345678-1234-1234-1234-123456789abc';
const token = 'M.C' + 'a'.repeat(90);

function one(content, expected = {}) {
  const result = parse(content);
  assert.deepEqual(result.errors, []);
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0], {
    email, password, client_id: clientID, refresh_token: token, note: 'OAuth登录', ...expected,
  });
}

for (const delimiter of ['----', '---', '\t', '|', '｜', ',', '，', ';', '；', ' ', ':', '：']) {
  test('识别分隔符 ' + JSON.stringify(delimiter), () => {
    one([email, password, clientID, token].join(delimiter));
    one([email, password, token, clientID].join(delimiter));
  });
}

test('兼容旧版四段不透明凭据', () => {
  one(`${email}----${password}----custom-client----short-token`, { client_id: 'custom-client', refresh_token: 'short-token' });
});

test('密码和令牌末尾的连字符不能丢失', () => {
  one(`${email}----${password}------${token}-----${clientID}`, { password: password + '--', refresh_token: token + '-' });
});

test('邮箱域名不包含后续连字符字段', () => {
  one(`${email}----plainpassword----${clientID}----${token}`, { password: 'plainpassword' });
});

test('Outlook 竖线数据包保留辅助邮箱', () => {
  one([email, password, token, clientID, 'backup@example.com'].join('|'), { note: 'backup@example.com' });
});

test('Outlook 五段格式允许末尾附加信息不是完整邮箱', () => {
  const refreshToken = 'M.C523_SN1.0.U.MsaArtifacts.-' + 'aB1!*'.repeat(30);
  one([email, password, refreshToken, clientID, 'someone@'].join('|'), {
    refresh_token: refreshToken, note: 'someone@',
  });
});

test('聊天复制的五段数据兼容邮箱和令牌的转义，不改写密码', () => {
  const refreshToken = 'M.C523_SN1.0.U.MsaArtifacts.-' + 'aB1!*'.repeat(30);
  const literalPassword = String.raw`secret\_part\@!`;
  one([email.replace('@', '\\@'), literalPassword, refreshToken.replace('_', '\\_'), clientID, 'someone@'].join('|'), {
    password: literalPassword, refresh_token: refreshToken, note: 'someone@',
  });
});

test('结构化格式也兼容邮箱和 Microsoft 令牌转义', () => {
  const refreshToken = 'M.C523_SN1.0.U.MsaArtifacts.-' + 'aB1!*'.repeat(30);
  one(JSON.stringify({ email: email.replace('@', '\\@'), password, client_id: clientID, refresh_token: refreshToken.replace('_', '\\_') }), {
    refresh_token: refreshToken,
  });
});

test('Graph 标识及缺少凭据的错误', () => {
  for (const marker of ['graph', 'Microsoft Graph API', 'Graph API收件', 'msgraph']) {
    one([email, password, token, clientID, marker].join('----'), { note: 'Graph API收件' });
  }
  assert.deepEqual(parse(`${email}|${password}|graph`).errors, [{ entry: 1, message: 'Graph API收件需要client_id和refresh_token' }]);
});

test('密码格式和空白内容', () => {
  one(`${email}:${password}`, { client_id: '', refresh_token: '', note: '' });
  assert.deepEqual(parse(' \uFEFF\r\n '), { items: [], errors: [] });
});

test('BOM、字段引号和 CRLF', () => {
  one(`\uFEFF "${email}"\t"${password}"\t"${clientID}"\t"${token}"\r\n`);
});

test('JSON 对象、中英文别名和辅助邮箱', () => {
  one(JSON.stringify({ 邮箱地址: email, 授权码: password, 'Client-ID': clientID, oauth_refresh_token: token, 辅助邮箱: 'backup@example.com', 备注: '已购入' }, null, 2), { note: '已购入 | 辅助邮箱：backup@example.com' });
});

test('JSON 数组、字符串数组、JSONL', () => {
  const object = { email, password, client_id: clientID, refresh_token: token };
  const line = [email, password, clientID, token].join('----');
  for (const content of [JSON.stringify([object, line]), JSON.stringify([line, line]), JSON.stringify(object) + '\n' + JSON.stringify(object)]) {
    const result = parse(content);
    assert.equal(result.items.length, 2);
    assert.deepEqual(result.errors, []);
  }
});

for (const delimiter of [',', '\t', '----', '|', '；', ' ']) {
  test('带表头记录 ' + JSON.stringify(delimiter), () => {
    one(['备注', '刷新令牌', '账号', '应用id', '密码', '忽略列'].join(delimiter) + '\n' +
      ['hello', token, email, clientID, password, 'extra'].join(delimiter), { note: 'hello' });
  });
}

test('CSV 引号及表头固定分隔符保护密码和备注', () => {
  one('email,password,client_id,refresh_token,note\n' +
    `${email},"a,b|c----d",${clientID},${token},"hello, ""world"""`, { password: 'a,b|c----d', note: 'hello, "world"' });
  one(`"${email}","a,b|c----d",${clientID},${token}`, { password: 'a,b|c----d' });
});

for (const separator of [' ', ' | ', '----', ',', ';', '\t']) {
  test('键值记录 ' + JSON.stringify(separator), () => {
    one([`email=${email}`, `password=${password}`, `client_id=${clientID}`, `refresh_token=${token}`].join(separator));
  });
}

test('键值中的引号内容原样保留', () => {
  one(`邮箱：${email} 密码="a,b|c----d password=still-secret" client id=${clientID} refresh token=${token} 备注="hello, world"`, {
    password: 'a,b|c----d password=still-secret', note: 'hello, world',
  });
});

test('键值 Graph 开关', () => {
  const base = `email=${email} password=${password} client_id=${clientID} refresh_token=${token}`;
  one(base + ' GraphAPI=yes', { note: 'Graph API收件' });
  one(base + ' GraphAPI=false');
  one(JSON.stringify({ email, password, client_id: clientID, refresh_token: token, mode: 'Graph API' }), { note: 'Graph API收件' });
});

test('多行键值块，以空行或重复邮箱分组', () => {
  const block = `email: ${email}\npassword: ${password}\nclient_id: ${clientID}\nrefresh_token: ${token}`;
  for (const separator of ['\n', '\n\n', '\r\n\r\n']) {
    const result = parse(block + separator + block);
    assert.equal(result.items.length, 2);
    assert.deepEqual(result.errors, []);
  }
});

test('错误逐条报告，不把键名或其他字段当密码', () => {
  const result = parse([`${email}|${password}|${token}|${clientID}`, 'not-an-email', email, JSON.stringify({ email, client_id: clientID, refresh_token: token })].join('\n'));
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.errors, [
    { entry: 2, message: '未识别到邮箱地址' },
    { entry: 3, message: '未识别到密码或授权码' },
    { entry: 4, message: '未识别到密码或授权码' },
  ]);
});

test('表头本身不能当作账号导入', () => {
  assert.deepEqual(parse('email,password,client_id,refresh_token'), { items: [], errors: [] });
});

test('空密码不能把后续凭据当成密码', () => {
  assert.deepEqual(parse(`${email}---- ----${clientID}----${token}`).errors, [{ entry: 1, message: '未识别到密码或授权码' }]);
});

test('键值密码末尾标点保留', () => {
  one(`email=${email} password="secret;" client_id=${clientID} refresh_token=${token}`, { password: 'secret;' });
  one(`email=${email} password=secret;`, { password: 'secret;', client_id: '', refresh_token: '', note: '' });
});

test('页面预览和实际提交使用相同解析结果', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const nodes = new Map();
  const requests = [], messages = [];
  const context = vm.createContext({
    document: {
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', style: {}, classList: {}, addEventListener() {} });
        return nodes.get(id);
      },
      querySelectorAll: () => [],
    },
    URLSearchParams, setInterval() {}, renderPager() {}, closeModal() {},
    toast: message => messages.push(message),
    async api(url, options) {
      requests.push({ url, options });
      return { ok: true, json: async () => options ? { added: 1, skipped: 0, queued: 1 } : { data: [], total: 0 } };
    },
  });
  for (const name of ['mailbox-import.js', 'mailboxes.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static', name), 'utf8'), context);
  }
  const content = `${email}|${password}|${token}|${clientID}|backup@example.com\ninvalid`;
  nodes.get('import-text').value = content;
  vm.runInContext('updateImportCount()', context);
  assert.equal(nodes.get('import-count').textContent, '已识别 1 个邮箱，未识别 1 条');
  assert.equal(nodes.get('import-errors').textContent, '第 2 条：未识别到邮箱地址');
  await vm.runInContext('doImport()', context);
  const request = requests.find(request => request.url === '/api/mailboxes/import');
  assert.deepEqual(JSON.parse(request.options.body), { items: parse(content).items });
  assert.match(messages[0], /新增 1，跳过 0，未识别 1 条/);
});
