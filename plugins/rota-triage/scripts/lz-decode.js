#!/usr/bin/env node
// Decode the `lz=` query parameter of a Kibana locator link
// (https://kibana…/app/r?l=DISCOVER_APP_LOCATOR&v=…&lz=…) into the locator state JSON.
// Dependency-free port of lz-string's decompressFromEncodedURIComponent.
// Usage: node lz-decode.js '<lz value or full URL>'   → prints JSON (pretty) or exits 1.
// Kibana emits compressToBase64 output (alphabet ends "+/=", URL-encoded as %2B %2F %3D);
// older links use compressToEncodedURIComponent (alphabet ends "+-$"). Detect by content.
const KEY_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
const KEY_URI = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+-$";
let dict = {};
function useAlphabet(keyStr) { dict = {}; for (let i = 0; i < keyStr.length; i++) dict[keyStr[i]] = i; }
function readBits(data, n, getNext, resetValue) {
  let bits = 0, power = 1, max = Math.pow(2, n);
  while (power !== max) {
    const resb = data.val & data.position; data.position >>= 1;
    if (data.position === 0) { data.position = resetValue; data.val = getNext(data.index++); }
    bits |= (resb > 0 ? 1 : 0) * power; power <<= 1;
  }
  return bits;
}
function decompress(input) {
  const len = input.length, resetValue = 32, getNext = i => dict[input.charAt(i)];
  const d = [0, 1, 2]; let enlargeIn = 4, dictSize = 4, numBits = 3, entry = "", result = [], w, c;
  const data = { val: getNext(0), position: resetValue, index: 1 };
  let next = readBits(data, 2, getNext, resetValue);
  switch (next) {
    case 0: c = String.fromCharCode(readBits(data, 8, getNext, resetValue)); break;
    case 1: c = String.fromCharCode(readBits(data, 16, getNext, resetValue)); break;
    case 2: return "";
  }
  d[3] = c; w = c; result.push(c);
  while (true) {
    if (data.index > len) return "";
    c = readBits(data, numBits, getNext, resetValue);
    switch (c) {
      case 0: d[dictSize++] = String.fromCharCode(readBits(data, 8, getNext, resetValue)); c = dictSize - 1; enlargeIn--; break;
      case 1: d[dictSize++] = String.fromCharCode(readBits(data, 16, getNext, resetValue)); c = dictSize - 1; enlargeIn--; break;
      case 2: return result.join("");
    }
    if (enlargeIn === 0) { enlargeIn = Math.pow(2, numBits); numBits++; }
    if (d[c]) entry = d[c]; else if (c === dictSize) entry = w + w.charAt(0); else return null;
    result.push(entry); d[dictSize++] = w + entry.charAt(0); enlargeIn--; w = entry;
    if (enlargeIn === 0) { enlargeIn = Math.pow(2, numBits); numBits++; }
  }
}
let arg = process.argv[2] || "";
if (!arg) { console.error("usage: lz-decode.js '<lz value or locator URL>'"); process.exit(2); }
arg = arg.replace(/&amp;/g, "&");
const m = arg.match(/(?:^|[?&])lz=([^&|>\s]+)/); if (m) arg = m[1];
try { arg = decodeURIComponent(arg); } catch (_) {}
arg = arg.replace(/ /g, "+").replace(/\.\.\.$|…$/, "");
useAlphabet(/[\/=]/.test(arg) ? KEY_B64 : KEY_URI);
const out = decompress(arg);
if (!out) { console.error("lz-decode: payload undecodable (truncated?)"); process.exit(1); }
try { console.log(JSON.stringify(JSON.parse(out), null, 2)); } catch (_) { console.log(out); }
