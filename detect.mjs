// Tells "the page is blocked and a human has to act" apart from "something is just slow".
export const MESSAGES = {
  logged_out: '登录已失效：请在本地重新登录，重新运行 export-login 导出 login.json，再上传到服务器',
  captcha: '页面出现验证码或安全验证：请在本地打开浏览器通过验证，重新导出 login.json 并上传',
};

export class BridgeError extends Error {
  constructor(kind, message = MESSAGES[kind]) {
    super(message);
    this.kind = kind;
  }
}

// Only call this after something already failed or stalled: normal chat text may contain words like "验证码".
export function blockKind(url, text) {
  let path = '';
  try { path = new URL(url).pathname; } catch {}
  if (/^\/(sign_in|login)/.test(path)) return 'logged_out';
  if (/安全验证|人机验证|请完成验证|滑动.{0,8}验证|拖动.{0,8}滑块|verify you are human|captcha/i.test(text ?? '')) return 'captcha';
  return null;
}
