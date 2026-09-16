import assert from "node:assert/strict";
import test from "node:test";
import { createAccessHtml, isPrivateIpv4, selectLanIpv4 } from "../scripts/ipad-dev.mjs";

test("RFC1918のIPv4だけをLANアドレスとして扱う", () => {
  for (const address of ["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.2.152"]) {
    assert.equal(isPrivateIpv4(address), true, address);
  }
  for (const address of ["127.0.0.1", "169.254.1.1", "172.32.0.1", "192.169.0.1", "8.8.8.8", "invalid"]) {
    assert.equal(isPrivateIpv4(address), false, address);
  }
});

test("複数のアダプターがある場合はWi-FiのプライベートIPv4を優先する", () => {
  const address = selectLanIpv4({
    "vEthernet (Default Switch)": [{ family: "IPv4", internal: false, address: "172.20.0.1" }],
    Ethernet: [{ family: "IPv4", internal: false, address: "10.0.0.8" }],
    "Wi-Fi": [{ family: "IPv4", internal: false, address: "192.168.2.152" }],
  });
  assert.equal(address, "192.168.2.152");
});

test("iPadアクセスファイルは現在URLへ自動遷移し、手動リンクも残す", () => {
  const url = "http://192.168.2.152:3000/";
  const html = createAccessHtml(url);
  assert.match(html, /http-equiv="refresh"/);
  assert.equal((html.match(new RegExp(url.replaceAll(".", "\\."), "g")) || []).length, 3);
  assert.match(html, />開発環境を開く<\/a>/);
});
