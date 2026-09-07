import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UpdateDraftProvider, useRecoverableState, useUpdateDraftBusy } from "./update-drafts";

function Example() {
  const [name] = useRecoverableState("example.name", () => "未保存の名前");
  const [zero] = useRecoverableState("example.zero", 0);
  useUpdateDraftBusy("example.file", false);
  return createElement("p", {}, `${name}:${zero}`);
}

describe("recoverable state server rendering", () => {
  it("works like useState without a provider", () => {
    expect(renderToStaticMarkup(createElement(Example))).toContain("未保存の名前:0");
  });
  it("does not access browser storage or automatically restore while server rendering", () => {
    const onRestoreView = () => { throw new Error("must not restore automatically"); };
    const markup = renderToStaticMarkup(createElement(UpdateDraftProvider, { userId: "test-user", environment: "accounting-dev", view: "common-casts", onRestoreView, children: createElement(Example) }));
    expect(markup).toContain("未保存の名前:0");
  });
});
