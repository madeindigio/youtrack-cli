import assert from "node:assert/strict";
import test from "node:test";

import { projectExportOptions, projectStatusOptions } from "../src/cli.js";

test("projectExportOptions applies the documented defaults", () => {
  const options = projectExportOptions("PRJ", {});

  assert.equal(options.project, "PRJ");
  assert.equal(options.out, "./PRJ");
  assert.equal(options.concurrency, 4);
  assert.equal(options.rate, 5);
  assert.equal(options.attachments, true);
  assert.equal(options.activities, true);
  assert.equal(options.articles, false);
  assert.equal(options.since, undefined);
  assert.equal(options.limit, undefined);
  assert.equal(options.fresh, false);
  assert.equal(options.force, false);
  assert.equal(options.json, false);
});

test("projectExportOptions sanitizes the default output directory", () => {
  assert.equal(projectExportOptions("A/B", {}).out, "./A_B");
  assert.equal(projectExportOptions("PRJ", { out: "./dump" }).out, "./dump");
});

test("projectExportOptions maps the --no-* flags to negated booleans", () => {
  const options = projectExportOptions("PRJ", { noAttachments: true, noActivities: true, articles: true });

  assert.equal(options.attachments, false);
  assert.equal(options.activities, false);
  assert.equal(options.articles, true);
});

test("projectExportOptions coerces numeric options to numbers", () => {
  const options = projectExportOptions("PRJ", { concurrency: "8", rate: "2", limit: "50" });

  assert.equal(options.concurrency, 8);
  assert.equal(options.rate, 2);
  assert.equal(options.limit, 50);
  assert.equal(typeof options.rate, "number");
});

test("projectExportOptions accepts a fractional rate", () => {
  assert.equal(projectExportOptions("PRJ", { rate: "0.5" }).rate, 0.5);
});

test("projectExportOptions rejects invalid numbers", () => {
  assert.throws(() => projectExportOptions("PRJ", { concurrency: "nope" }), /--concurrency must be a positive number/);
  assert.throws(() => projectExportOptions("PRJ", { rate: "0" }), /--rate must be a positive number/);
  assert.throws(() => projectExportOptions("PRJ", { limit: "-3" }), /--limit must be a positive number/);
  assert.throws(() => projectExportOptions("PRJ", { concurrency: "1.5" }), /--concurrency must be an integer/);
});

test("projectExportOptions rejects value options used as bare flags", () => {
  assert.throws(() => projectExportOptions("PRJ", { out: true }), /--out requires a value/);
  assert.throws(() => projectExportOptions("PRJ", { concurrency: true }), /--concurrency requires a number/);
});

test("projectExportOptions requires a project key", () => {
  assert.throws(() => projectExportOptions(undefined, {}), /Usage: yt project export <projectKey>/);
  assert.throws(() => projectExportOptions("", {}), /Usage: yt project export <projectKey>/);
});

test("projectStatusOptions resolves the export directory", () => {
  assert.deepEqual(projectStatusOptions("PRJ", {}), { out: "./PRJ", json: false });
  assert.deepEqual(projectStatusOptions(undefined, { out: "./dump", json: true }), { out: "./dump", json: true });
  assert.throws(() => projectStatusOptions(undefined, {}), /Usage: yt project status/);
});
