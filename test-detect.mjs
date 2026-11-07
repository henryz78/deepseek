import assert from 'node:assert/strict';
import { blockKind } from './detect.mjs';

assert.equal(blockKind('https://chat.deepseek.com/sign_in', ''), 'logged_out');
assert.equal(blockKind('https://chat.deepseek.com/login?x=1', 'hello'), 'logged_out');
assert.equal(blockKind('https://chat.deepseek.com/a/chat/s/abc', '请先完成安全验证'), 'captcha');
assert.equal(blockKind('https://chat.deepseek.com/', 'Please verify you are human'), 'captcha');
assert.equal(blockKind('https://chat.deepseek.com/', '嗨！今天想聊些什么？'), null);
assert.equal(blockKind('https://chat.deepseek.com/a/chat/s/abc', '短信验证码是6位数字'), null, 'a normal word is not a block');
assert.equal(blockKind('not a url', null), null);
console.log('DETECT OK');
