// Scratch probe for src/lib/roadmap/url-check.ts. Not part of test:roadmap;
// the permanent pins land in scripts/roadmap-tests.ts.
import {
  checkUrlReachable,
  isBlockedAddress,
  parseCheckableUrl,
  statusCounts,
} from "@/lib/roadmap/url-check";

let fail = 0;
function eq(label: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"} - ${label}${ok ? "" : ` (got ${JSON.stringify(got)} want ${JSON.stringify(want)})`}`);
}

console.log("--- blocked addresses ---");
for (const a of [
  "127.0.0.1", "127.1.2.3", "10.0.0.5", "172.16.0.1", "172.31.255.255",
  "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
  "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.0.1",
  "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1",
  "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:7f00:1",
  "64:ff9b::127.0.0.1",
]) eq(`blocked ${a}`, isBlockedAddress(a), true);

console.log("--- allowed addresses ---");
for (const a of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "2606:4700::1111"])
  eq(`allowed ${a}`, isBlockedAddress(a), false);

console.log("--- parse ---");
for (const u of [
  "ftp://example.com/", "file:///etc/passwd", "javascript:alert(1)",
  "data:text/html,x", "http://user:pw@example.com/", "gopher://x/",
  "", "   ", "http://", "not a url",
]) eq(`reject ${JSON.stringify(u)}`, parseCheckableUrl(u), null);

for (const u of ["http://example.com:8443/a?b=c", "https://example.com/", "http://1.2.3.4:9000/"])
  eq(`accept ${u}`, parseCheckableUrl(u) !== null, true);

console.log("--- status vocabulary ---");
eq("200 counts", statusCounts(200), true);
eq("401 counts", statusCounts(401), true);
eq("403 counts", statusCounts(403), true);
eq("404 does not", statusCounts(404), false);
eq("500 does not", statusCounts(500), false);

console.log("--- live checks (network) ---");
console.log("  example.com     ", JSON.stringify(await checkUrlReachable("https://example.com/")));
console.log("  404 path        ", JSON.stringify(await checkUrlReachable("https://example.com/definitely-not-here-9z8y")));
console.log("  loopback literal", JSON.stringify(await checkUrlReachable("http://127.0.0.1:3000/")));
console.log("  metadata ip     ", JSON.stringify(await checkUrlReachable("http://169.254.169.254/latest/meta-data/")));
console.log("  mapped v6 loop  ", JSON.stringify(await checkUrlReachable("http://[::ffff:127.0.0.1]:3000/")));
console.log("  redirector      ", JSON.stringify(await checkUrlReachable("http://google.com/")));
console.log("  dead name       ", JSON.stringify(await checkUrlReachable("https://nx-does-not-exist-9z8y7x.example/")));
console.log("  own site        ", JSON.stringify(await checkUrlReachable("https://ai.xl.net/")));

console.log(fail === 0 ? "\nALL UNIT PINS PASSED" : `\n${fail} PINS FAILED`);
