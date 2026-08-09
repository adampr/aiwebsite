import { isBlockedAddress, parseCheckableUrl, statusCounts } from "../src/lib/roadmap/url-check";
const cases = [
 "127.0.0.1","169.254.169.254","10.0.0.1","::1","::","fe80::1","fc00::1",
 "::ffff:127.0.0.1","::ffff:7f00:1","0:0:0:0:0:ffff:127.0.0.1","0:0:0:0:0:ffff:a9fe:a9fe",
 "64:ff9b::1","64:ff9b::7f00:1","64:ff9b::a9fe:a9fe","64:ff9b::169.254.169.254",
 "168.63.129.16","2002:7f00:1::","2001:db8::1","100::1",
 "8.8.8.8","2606:4700::1111","93.184.216.34","3fff::1",
];
for (const c of cases) console.log(String(isBlockedAddress(c)).padEnd(6), c);
console.log("--- URL normalization ---");
for (const u of ["http://[64:ff9b::169.254.169.254]/","http://[::ffff:169.254.169.254]/","http://0177.0.0.1/","http://2130706433/","http://0/","http://168.63.129.16:80/"]) {
  try { const p = new URL(u); console.log(u,"->",p.hostname, "parse:", JSON.stringify(parseCheckableUrl(u))); }
  catch(e){ console.log(u,"-> PARSE FAIL"); }
}
