








import { describe, it, expect } from "vitest";
import { isWebNavUrl, normalizeBrowserUrl } from "../../gui/src/renderer/pages/browserBridge.js";

describe("isWebNavUrl（自定义协议守卫）", () => {
  it("放行 http / https / 无 scheme（将补 https://）", () => {
    expect(isWebNavUrl("https://www.douyin.com")).toBe(true);
    expect(isWebNavUrl("http://example.com")).toBe(true);
    expect(isWebNavUrl("douyin.com")).toBe(true);
    expect(isWebNavUrl("www.bilibili.com/video/BV1xx")).toBe(true);
  });

  it("放行 about:blank / 空值 / file / data / blob", () => {
    expect(isWebNavUrl("about:blank")).toBe(true);
    expect(isWebNavUrl("")).toBe(true);
    expect(isWebNavUrl(undefined)).toBe(true);
    expect(isWebNavUrl("data:text/html,<h1>hi</h1>")).toBe(true);
    expect(isWebNavUrl("blob:https://example.com/uuid")).toBe(true);
  });

  it("拦截 bitbrowser:// 等自定义协议（弹窗根因）", () => {
    expect(isWebNavUrl("bitbrowser://open?env=1")).toBe(false);
    expect(isWebNavUrl("BITBROWSER://open")).toBe(false); 
    expect(isWebNavUrl("weixin://dl/chat")).toBe(false);
    expect(isWebNavUrl("mailto:a@b.com")).toBe(false);
    expect(isWebNavUrl("slime://agent/123")).toBe(false);
  });
});

describe("normalizeBrowserUrl（A-980-R6 统一 URL 归一）", () => {
  it("裸地址补 http://（本地 IP:端口 不再错拼 https）", () => {
    expect(normalizeBrowserUrl("127.0.0.1:8081")).toBe("http://127.0.0.1:8081");
    expect(normalizeBrowserUrl("localhost:3000/a")).toBe("http://localhost:3000/a");
    expect(normalizeBrowserUrl("douyin.com")).toBe("http://douyin.com");
    expect(normalizeBrowserUrl("www.bilibili.com/video/BV1xx")).toBe("http://www.bilibili.com/video/BV1xx");
  });

  it("已带协议头保持不变", () => {
    expect(normalizeBrowserUrl("http://127.0.0.1:8081/")).toBe("http://127.0.0.1:8081/");
    expect(normalizeBrowserUrl("https://www.douyin.com")).toBe("https://www.douyin.com");
    expect(normalizeBrowserUrl("about:blank")).toBe("about:blank");
    expect(normalizeBrowserUrl("file:///c:/x.html")).toBe("file:///c:/x.html");
    
    expect(normalizeBrowserUrl("bitbrowser://open?env=1")).toBe("bitbrowser://open?env=1");
    expect(normalizeBrowserUrl("mailto:a@b.com")).toBe("mailto:a@b.com");
  });

  it("空值/空白原样返回（不触发导航）", () => {
    expect(normalizeBrowserUrl("")).toBe("");
    expect(normalizeBrowserUrl(undefined)).toBe("");
    expect(normalizeBrowserUrl("  ")).toBe("");
  });
});