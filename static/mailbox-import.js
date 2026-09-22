/* 邮箱导入识别：浏览器与 Node 测试共用，不依赖第三方库。 */
(function (root) {
  'use strict';

  const EMAIL_SOURCE = "[\\w.!#$%&'*+/=?^_`{|}~-]+@[\\w.-]+\\.[A-Za-z]{2,}";
  const EMAIL = new RegExp('^' + EMAIL_SOURCE + '$', 'i');
  const EMAIL_SEARCH = new RegExp(EMAIL_SOURCE, 'i');
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ALIASES = {
    email: ['email', 'mail', 'email_address', 'mail_address', 'account_email', '邮箱', '邮箱地址', '账号', '帐号', '账户', 'account'],
    username: ['username', 'user', 'login', 'login_name', '登录名', '用户名'],
    password: ['password', 'passwd', 'pass', 'pwd', 'mail_password', '密码', '邮箱密码', '授权码'],
    client_id: ['client_id', 'clientid', 'client', 'cid', 'app_id', 'appid', 'application_id', 'oauth_client_id', '应用id', '客户端id'],
    refresh_token: ['refresh_token', 'refreshtoken', 'refresh', 'oauth_token', 'oauth_refresh_token', 'token', '刷新令牌', '刷新token'],
    recovery_email: ['recovery_email', 'recovery', 'backup_email', 'secondary_email', '辅助邮箱', '恢复邮箱', '备用邮箱'],
    auth_type: ['auth_type', 'authtype', 'auth', 'login_type', 'receive_type', 'receive', 'api', 'mode', '类型', '收件方式'],
    remarks: ['remarks', 'remark', 'note', 'notes', '备注'],
  };
  const KEYS = new Map(Object.entries(ALIASES).flatMap(([key, aliases]) => aliases.map(alias => [alias, key])));

  function clean(value) {
    let text = String(value ?? '').trim().replace(/^\uFEFF/, '');
    if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text.at(-1) === text[0]) {
      text = text.slice(1, -1).trim();
    }
    return text;
  }

  function canonical(key) {
    return KEYS.get(clean(key).toLowerCase().replace(/[\s-]+/g, '_').replace(/_+/g, '_')) || '';
  }

  function normalizeEmail(value) {
    // 聊天/Markdown 复制可能把邮箱中的 @ 和 _ 写成 \@、\_。
    return value.replace(/\\([@_])/g, '$1');
  }

  function normalizeRefreshToken(value) {
    // 仅处理 Microsoft 令牌中的下划线转义；密码及其他不透明凭据不做全局反转义。
    return /^(M\.C|0\.A)/.test(value) ? value.replace(/\\_/g, '_') : value;
  }

  function looksLikeRefreshToken(value) {
    return value.length >= 80 || (/^(M\.C|0\.A|1\/\/)/.test(value) && value.length >= 30);
  }

  function isGraph(value) {
    const normalized = clean(value).toLowerCase().replace(/[\s_\-:/\\|,;()（）]+/g, '');
    return ['graph', 'graphapi', 'msgraph', 'microsoftgraph', 'microsoftgraphapi'].includes(normalized) ||
      (normalized.includes('graph') && (normalized.includes('api') || value.includes('收件')));
  }

  function splitHyphens(line) {
    const matches = [...line.matchAll(/-{4,}/g)];
    if (!matches.length) return line.split('---');
    const parts = [];
    let start = 0;
    for (const match of matches) {
      const end = match.index + match[0].length;
      // 最后四个连字符作为分隔符，前面的仍属于密码或令牌。
      parts.push(line.slice(start, end - 4));
      start = end;
    }
    parts.push(line.slice(start));
    return parts;
  }

  function splitCSV(line, delimiter) {
    const parts = [];
    let value = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted && ch === '"') {
        if (line[i + 1] === '"') { value += '"'; i++; }
        else quoted = false;
      } else if (!quoted && ch === '"' && !value.trim()) {
        quoted = true;
      } else if (!quoted && ch === delimiter) {
        parts.push(value);
        value = '';
      } else value += ch;
    }
    parts.push(value);
    return parts;
  }

  function delimiterFor(line) {
    // 引号内部的标点属于字段内容，不参与分隔符判断。
    const outside = line.replace(/"(?:[^"]|"")*"/g, '');
    if (/-{3,}/.test(outside)) return 'hyphens';
    for (const delimiter of ['\t', '｜', '|', '，', ',', '；', ';']) {
      if (outside.includes(delimiter)) return delimiter;
    }
    if (new RegExp('^' + EMAIL_SOURCE + '\\s*[:：]', 'i').test(line)) return 'colon';
    return 'space';
  }

  function splitLine(line, delimiter = delimiterFor(line)) {
    if (delimiter === 'hyphens') return splitHyphens(line).map(clean);
    if (delimiter === 'colon') return line.split(/[:：]/).map(clean);
    if (delimiter === 'space') return line.split(/\s+/).filter(Boolean).map(clean);
    return splitCSV(line, delimiter).map(clean);
  }

  function parseFields(line) {
    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        const object = JSON.parse(line);
        if (object && !Array.isArray(object)) {
          const fields = {};
          for (const [key, value] of Object.entries(object)) {
            const name = canonical(key);
            if (name) fields[name] = clean(value);
          }
          return fields;
        }
      } catch (_) { /* 继续尝试键值格式。 */ }
    }

    // 只用已知 key 的下一个赋值作为值边界，保留值内的 UUID、逗号和竖线。
    const candidates = [];
    const pattern = /(?:^|[\s|｜,，;；]|-{3,})[ \t]*([\p{L}\p{N}_-]+(?:[ \t]+[\p{L}\p{N}_-]+)?)\s*[:=：]\s*/gu;
    let quote = '', scanned = 0;
    for (const match of line.matchAll(pattern)) {
      for (; scanned < match.index; scanned++) {
        const ch = line[scanned];
        if (quote) {
          if (ch === quote && line[scanned - 1] !== '\\') quote = '';
        } else if ((ch === '"' || ch === "'") && (scanned === 0 || /[\s=:：]/.test(line[scanned - 1]))) quote = ch;
      }
      if (quote) continue;
      const key = canonical(match[1]);
      if (key || isGraph(match[1])) {
        const hyphens = match[0].match(/^-{4,}/)?.[0].length || 4;
        candidates.push({ key: key || 'graph_marker', start: match.index + hyphens - 4, end: match.index + match[0].length });
      }
    }
    const fields = {};
    candidates.forEach((match, index) => {
      const end = candidates[index + 1]?.start ?? line.length;
      // 分隔符只从相邻字段间移除，不改写密码/令牌的内部字符。
      const value = clean(line.slice(match.end, end));
      if (match.key === 'graph_marker') {
        if (!['0', 'false', 'no', '否'].includes(value.toLowerCase())) fields.auth_type = 'graph';
      } else fields[match.key] = value;
    });
    return fields;
  }

  function expand(content) {
    const raw = String(content ?? '').trim().replace(/^\uFEFF/, '');
    if (!raw) return [];
    if (raw.startsWith('{') || raw.startsWith('[')) {
      try {
        const payload = JSON.parse(raw);
        const entries = Array.isArray(payload) ? payload : [payload];
        return entries.map(value => typeof value === 'object' && value !== null ? JSON.stringify(value) : clean(value)).filter(Boolean);
      } catch (_) { /* JSONL 或普通文本继续逐行展开。 */ }
    }
    const source = raw.split(/\r\n|\n|\r/);
    const lines = source.map(line => line.trim()).filter(Boolean);
    const header = splitLine(lines[0]).map(canonical);
    if (header.includes('email') && header.filter(Boolean).length >= 2) {
      const delimiter = delimiterFor(lines[0]);
      return lines.slice(1).map(line => {
        const values = splitLine(line, delimiter);
        const record = {};
        header.forEach((key, i) => { if (key && values[i]) record[key] = values[i]; });
        return JSON.stringify(record);
      });
    }
    if (lines.length > 1) {
      const blocks = [];
      let current = {}, multiline = true;
      for (const rawLine of source) {
        const line = rawLine.trim();
        if (!line) {
          if (Object.keys(current).length) { blocks.push(current); current = {}; }
          continue;
        }
        const fields = Object.entries(parseFields(line));
        if (fields.length !== 1) { multiline = false; break; }
        const [key, value] = fields[0];
        if (key === 'email' && current.email) { blocks.push(current); current = {}; }
        current[key] = value;
      }
      if (Object.keys(current).length) blocks.push(current);
      if (multiline && blocks.length && blocks.every(block => block.email)) return blocks.map(block => JSON.stringify(block));
    }
    return lines;
  }

  function parseLine(line) {
    const fields = parseFields(line);
    const structured = Object.keys(fields).length > 0 || line.startsWith('{');
    const tokens = structured ? [] : splitLine(line);
    const emailIndex = tokens.findIndex(token => EMAIL.test(normalizeEmail(token)));
    const email = structured ? normalizeEmail(fields.email || '').match(EMAIL_SEARCH)?.[0] : normalizeEmail(tokens[emailIndex] || '');
    if (!email) return { error: '未识别到邮箱地址' };

    let password = fields.password || '';
    let clientID = fields.client_id || '';
    let refreshToken = normalizeRefreshToken(fields.refresh_token || '');
    let graph = isGraph(fields.auth_type || '');
    const used = new Set([emailIndex]);
    if (!structured) {
      const passwordIndex = emailIndex + 1;
      if (passwordIndex < tokens.length) { password = tokens[passwordIndex]; used.add(passwordIndex); }
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (!token || used.has(i)) continue;
        if (isGraph(token)) { graph = true; used.add(i); }
        else if (!clientID && UUID.test(token)) { clientID = token; used.add(i); }
        else if (!refreshToken && looksLikeRefreshToken(token)) { refreshToken = normalizeRefreshToken(token); used.add(i); }
      }
      // 保留旧版四段格式对不透明 client_id / 短令牌的兼容。
      if (tokens.length === 4 && emailIndex === 0 && password && !graph) {
        if (!clientID && !used.has(2)) { clientID = tokens[2]; used.add(2); }
        if (!refreshToken && !used.has(3)) { refreshToken = normalizeRefreshToken(tokens[3]); used.add(3); }
      }
      if (line.includes('|') && clientID && refreshToken && tokens.some((token, index) => index !== emailIndex && EMAIL.test(normalizeEmail(token)))) graph = true;
    }
    if (!password) return { error: '未识别到密码或授权码' };
    if (graph && !(clientID && refreshToken)) return { error: 'Graph API收件需要client_id和refresh_token' };

    const notes = [fields.remarks || ''];
    tokens.forEach((token, i) => { if (token && !used.has(i)) notes.push(token); });
    if (fields.recovery_email && fields.recovery_email !== email) notes.push('辅助邮箱：' + fields.recovery_email);
    let note = notes.filter(Boolean).join(' | ');
    if (!note && clientID && refreshToken) note = graph ? 'Graph API收件' : 'OAuth登录';
    return { item: { email, password, client_id: clientID, refresh_token: refreshToken, note } };
  }

  function parse(content) {
    const items = [], errors = [];
    expand(content).forEach((entry, index) => {
      const result = parseLine(entry);
      if (result.item) items.push(result.item);
      else errors.push({ entry: index + 1, message: result.error });
    });
    return { items, errors };
  }

  const api = { parse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MailboxImport = api;
})(globalThis);
