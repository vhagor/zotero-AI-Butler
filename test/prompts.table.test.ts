import { expect } from "chai";
import {
  getDefaultTableFillPrompt,
  getDefaultTableTemplate,
} from "../src/utils/prompts";

describe("table prompt defaults", function () {
  it("requires source-code availability in table fill outputs", function () {
    const template = getDefaultTableTemplate();
    const prompt = getDefaultTableFillPrompt();

    expect(template).to.contain("| GitHub 源码 | |");
    expect(prompt).to.contain("GitHub 源码");
    expect(prompt).to.contain("完整 URL");
    expect(prompt).to.contain("未提供源码，该论文不推荐阅读");
  });
});
