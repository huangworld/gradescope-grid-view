// node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuery, tokenize } from "../extension/content/query.js";

const m = (q, text) => parseQuery(q).pred(text);

test("empty → null", () => {
  assert.equal(parseQuery(""), null);
  assert.equal(parseQuery("   "), null);
  assert.equal(parseQuery(undefined), null);
});

test("bare word: case-insensitive substring, whitespace-normalised", () => {
  assert.ok(m("Foo", "a foo b"));
  assert.ok(m("foo", "A FOO B"));
  assert.ok(!m("foo", "fo o"));
  assert.ok(m('"two  words"', "one two\n   words"));
});

test("implicit AND, explicit AND/&&/&", () => {
  assert.ok(m("foo bar", "bar then foo"));
  assert.ok(!m("foo bar", "only foo"));
  assert.ok(m("foo AND bar", "foo bar"));
  assert.ok(m("foo && bar", "foo bar"));
  assert.ok(m("foo & bar", "foo bar"));
  assert.ok(m("foo and bar", "foo bar")); // keywords case-insensitive
});

test("OR / || / |", () => {
  assert.ok(m("foo OR bar", "bar"));
  assert.ok(m("foo || bar", "foo"));
  assert.ok(m("foo | bar", "bar"));
  assert.ok(!m("foo OR bar", "baz"));
});

test("NOT / ! / -", () => {
  assert.ok(m("NOT foo", "bar"));
  assert.ok(!m("NOT foo", "foo"));
  assert.ok(m("!foo", "bar"));
  assert.ok(m("-foo", "bar"));
  assert.ok(m("foo -bar", "foo"));
  assert.ok(!m("foo -bar", "foo bar"));
  assert.ok(m("a - b", "a - b")); // lone dash is a word
  assert.ok(m("NOT NOT foo", "foo"));
});

test("precedence NOT > AND > OR, parens", () => {
  // a OR b AND c  ==  a OR (b AND c)
  assert.ok(m("a OR b AND c", "a"));
  assert.ok(!m("a OR b AND c", "b"));
  assert.ok(m("a OR b AND c", "b c"));
  assert.ok(!m("(a OR b) AND c", "a"));
  assert.ok(m("(a OR b) AND c", "a c"));
  assert.ok(!m("NOT a AND b", "a b"));
  assert.ok(m("NOT (a AND b)", "a"));
  assert.ok(m("foo AND (bar OR /ba+z/) NOT qux", "foo baaz"));
  assert.ok(!m("foo AND (bar OR /ba+z/) NOT qux", "foo baaz qux"));
});

test("regex: default i flag, explicit flags, escaped slash", () => {
  assert.ok(m("/FOO/", "foo"));
  assert.ok(!m("/FOO/g", "foo"));
  assert.ok(m("/^\\d{3}$/m", "x\n123\ny"));
  assert.ok(m("/a\\/b/", "a/b"));
  // regex sees raw text (not whitespace-normalised)
  assert.ok(m("/a\\n\\s+b/", "a\n   b"));
  // g flag must not leave lastIndex state behind
  const { pred } = parseQuery("/foo/g");
  assert.ok(pred("foo"));
  assert.ok(pred("foo"));
});

test("errors carry pos", () => {
  const err = (q) => {
    try {
      parseQuery(q);
    } catch (e) {
      return e;
    }
    assert.fail(`expected throw for ${q}`);
  };
  assert.match(err("(a OR b").message, /missing \)/);
  assert.equal(err("a)").pos, 1);
  assert.match(err('"abc').message, /quote/);
  assert.match(err("/abc").message, /regex/);
  assert.match(err("/(/").message, /bad regex/);
  assert.match(err("a AND").message, /end of query/);
  assert.match(err("AND a").message, /unexpected AND/);
  assert.match(err("a OR OR b").message, /unexpected OR/);
});

test("tokenize: parens split words", () => {
  assert.deepEqual(
    tokenize("(foo)bar").map((t) => t.t),
    ["(", "term", ")", "term"]
  );
});

test("terms list", () => {
  assert.deepEqual(
    parseQuery("a AND (b OR /c/i) NOT d").terms.map((t) => t.v),
    ["a", "b", "c", "d"]
  );
});

test("highlight matchers: positive terms only, ranges on raw text", () => {
  const { highlight } = parseQuery('apple AND (pie OR /ta+rt/) NOT banana -"fig jam"');
  assert.equal(highlight.length, 3); // apple, pie, /ta+rt/ ; banana and "fig jam" are negated
  const raw = "Apple PIE\n  taart banana fig jam";
  const ranges = highlight.flatMap((f) => f(raw)).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(ranges, [[0, 5], [6, 9], [12, 17]]);
});

test("highlight matchers: phrase spans whitespace/newline, NOT NOT is positive, regex g safe", () => {
  const q1 = parseQuery('"two words"');
  assert.deepEqual(q1.highlight[0]("x two\n   words y"), [[2, 14]]);
  assert.equal(parseQuery("NOT NOT foo").highlight.length, 1);
  assert.equal(parseQuery("NOT (a OR b)").highlight.length, 0);
  const re = parseQuery("/o/g").highlight[0];
  assert.deepEqual(re("foo"), [[1, 2], [2, 3]]);
  assert.deepEqual(re("foo"), [[1, 2], [2, 3]]); // lastIndex reset
  assert.deepEqual(parseQuery("/x*/").highlight[0]("abc"), []); // zero-length matches ignored
});
