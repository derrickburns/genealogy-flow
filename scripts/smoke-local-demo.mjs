#!/usr/bin/env node
import assert from "node:assert/strict";

const url = process.argv.slice(2).find(arg => arg !== "--") || "http://127.0.0.1:8788/api/demo";

const response = await fetch(url);
const body = await response.text();

assert.equal(response.status, 200, `/api/demo should return 200 after local R2 is seeded. Got ${response.status}: ${body.slice(0, 300)}`);

const json = JSON.parse(body);
assert.ok(Array.isArray(json.individuals), "demo response should contain individuals[]");
assert.ok(Array.isArray(json.families), "demo response should contain families[]");
assert.ok(json.individuals.length > 0, "demo response should include at least one individual");
assert.equal(json.privacy?.tier, "public-demo", "demo response should be the sanitized public demo");

console.log(`Local demo smoke passed: ${json.individuals.length} individuals, ${json.families.length} families.`);
