/* THE DOCS PAGE. It fetches docs.md and draws it with a parser for one small,
   fixed subset of Markdown - the subset the docs are written in, and nothing
   more. Every node is built with createElement and every piece of the file
   goes in through textContent or a text node, so nothing in the file can ever
   become markup: a "<script>" in docs.md is eleven characters on the page. */
(function () {
  "use strict";

  // ------------------------------------------------------------------ syntax

  // THE MARKER ALONE, the text is taken by hand: a regex that also had to find
  // where the text ends backtracks quadratically on a line of spaces.
  var RE_HEADING_MARK = /^(#{1,3}) +/;
  var RE_HR = /^\s*-{3,}\s*$/;
  // A FENCE IS ``` WITH NO OTHER BACKTICK ON THE LINE. "```x``` and more" is a
  // sentence that starts with inline code, not a fence that would swallow the
  // rest of the file into one code block.
  var RE_FENCE_OPEN = /^\s*```[^`]*$/;
  var RE_FENCE_CLOSE = /^\s*```\s*$/;
  // "> text" or a bare ">" (a blank line inside the callout). ">text" with no
  // space is left alone, so a line opening with ">= 5 ETH" stays a sentence.
  var RE_QUOTE = /^\s*>(?: (.*))?$/;
  var RE_UL = /^(\s*)[-*] +(.*)$/;
  var RE_OL = /^(\s*)(\d{1,9})\. +(.*)$/;
  var RE_TABLE_ROW = /^\s*\|/;
  var RE_SEP_CELL = /^:?-+:?$/;
  var RE_TONE = /^\*\*(Note|Warning|Tip):\*\*/;
  // THE ONLY LINKS THAT BECOME LINKS: absolute http(s), a page of this site by
  // its bare file name or by its name (/docs, / for the launches: the names
  // vercel.json and _redirects serve), or an anchor on this page. Anchors are
  // the characters a heading id can hold, so every heading can be linked and
  // nothing else can be smuggled in through the fragment.
  var RE_PAGE_LINK = /^([a-z0-9-]+\.html|\/(?:launchpad|launches|curb|docs|migrate|terms|sharing)?)(#[a-z0-9-]+)?$/;
  var RE_ANCHOR_LINK = /^#[a-z0-9-]+$/;
  var MAX_DEPTH = 8;
  // Longest link target looked at. It bounds the scan for the closing ")", so
  // a paragraph full of "[a](" stays linear.
  var MAX_URL = 2048;
  // Longest bold or italic run, for the same reason (see findClose).
  var MAX_SPAN = 2000;
  // IDS A HEADING MAY NOT TAKE. An element id is also a property of window
  // when no real global has that name, so a "## Ethereum" section would make
  // window.ethereum the heading on a browser with no wallet, and the bar would
  // then take a <h2> for a wallet and call .request on it. Such a heading gets
  // "-2" as if the name were already used. Only lowercase names without "-"
  // matter: every slug is lowercase, and nothing reads window["a-b"].
  var RESERVED_IDS = ["ethereum", "web3", "solana", "phantom", "trustwallet", "okxwallet", "bitkeep"];

  function isBlank(line) { return !/\S/.test(line); }
  function indentOf(line) { return /^ */.exec(line)[0].length; }
  function el(tag, cls) { var n = document.createElement(tag); if (cls) n.className = cls; return n; }

  // Heading ids: lowercase, every run outside [a-z0-9] becomes one "-",
  // trimmed. Anything non-ASCII is outside that set by design, so an id never
  // depends on how a browser normalises Unicode.
  function slug(text) {
    return String(text == null ? "" : text).toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  // `next` remembers the last suffix tried for each base, so a hundred
  // headings of the same name do not each count up from -2 again.
  function uniqueId(base, used, next) {
    base = base || "section";
    var id = base, k = next[base] || 1;
    if (k > 1) id = base + "-" + k;
    while (used[id]) { k += 1; id = base + "-" + k; }
    next[base] = k;
    used[id] = true;
    return id;
  }

  // "# Title" -> { level, text }, or null. The text is trimmed; a marker with
  // nothing after it is not a heading.
  function matchHeading(line) {
    var m = RE_HEADING_MARK.exec(line);
    if (!m) return null;
    var text = line.slice(m[0].length).trim();
    return text ? { level: m[1].length, text: text } : null;
  }

  // "|---|:-:|" -> true. Done cell by cell rather than with one regex, whose
  // runs of optional spaces backtrack quadratically on a long line.
  function isSepRow(line) {
    var s = line.trim();
    if (s.indexOf("-") < 0 || s.indexOf("|") < 0) return false;
    if (s.charAt(0) === "|") s = s.slice(1);
    if (s.charAt(s.length - 1) === "|") s = s.slice(0, -1);
    var cells = s.split("|");
    for (var k = 0; k < cells.length; k++) if (!RE_SEP_CELL.test(cells[k].trim())) return false;
    return true;
  }

  // ---------------------------------------------------------- comment pass

  // COMMENTS GO FIRST, before any block is recognised, because one may span
  // several lines and sit anywhere. Inside a fenced block nothing is a comment
  // (the fence is verbatim); everywhere else, a `code span` included, one is.
  // A code span is no exception because this pass sees lines and the inline
  // pass sees whole paragraphs: a stray backtick on an earlier line pairs the
  // spans differently there, and a comment this pass had kept as "code" would
  // be printed as text. A line that held only a comment is dropped outright
  // rather than left blank, so a comment inside a paragraph does not split it.
  //
  // WHAT IS A FENCE HERE MUST BE A FENCE TO THE BLOCK PASS, or a comment in
  // what this pass took for code would reach the page as text. Both use
  // RE_FENCE_OPEN / RE_FENCE_CLOSE, and the block pass treats such a line as a
  // fence wherever it stands (a paragraph, a list item, after a table).
  function stripComments(lines) {
    var out = [];
    var inFence = false;
    var state = { inComment: false };
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (inFence) {
        out.push(line);
        if (RE_FENCE_CLOSE.test(line)) inFence = false;
        continue;
      }
      if (!state.inComment && RE_FENCE_OPEN.test(line)) {
        inFence = true;
        out.push(expandTabs(line));
        continue;
      }
      var kept = dropComments(line, state);
      if (isBlank(kept) && !isBlank(line)) continue;
      kept = expandTabs(kept);
      // "<!-- x --> ```" leaves a fence behind once the comment is gone, and
      // the block pass will open one there, so this pass does too. A comment
      // left open on that line is then inside the fence: shown, as the block
      // pass would show it.
      if (RE_FENCE_OPEN.test(kept)) { inFence = true; state.inComment = false; }
      out.push(kept);
    }
    return out;
  }

  function dropComments(line, state) {
    var out = "";
    var k = 0;
    while (k < line.length) {
      if (state.inComment) {
        var end = line.indexOf("-->", k);
        if (end < 0) return out;
        state.inComment = false;
        k = end + 3;
        continue;
      }
      var start = line.indexOf("<!--", k);
      if (start < 0) return out + line.slice(k);
      out += line.slice(k, start);
      state.inComment = true;
      k = start + 4;
    }
    return out;
  }

  // Leading tabs count as four spaces, so a tab-indented continuation line
  // under a list item is recognised as one.
  function expandTabs(line) {
    return line.replace(/^\t+/, function (t) { return new Array(t.length + 1).join("    "); });
  }

  // ------------------------------------------------------------ block pass

  function isTableStart(lines, i) {
    return i + 1 < lines.length && RE_TABLE_ROW.test(lines[i]) && isSepRow(lines[i + 1]);
  }

  // What ends a paragraph without a blank line. A numbered item interrupts one
  // only when it is "1.", because a wrapped sentence that happens to put
  // "2024." at the start of a line is still the same sentence.
  function startsBlock(lines, i, ctx, inPara) {
    var l = lines[i];
    if (RE_FENCE_OPEN.test(l) || RE_HR.test(l)) return true;
    if (!ctx.inQuote && (matchHeading(l) || RE_QUOTE.test(l))) return true;
    if (RE_UL.test(l)) return true;
    var o = RE_OL.exec(l);
    if (o && (!inPara || Number(o[2]) === 1)) return true;
    return isTableStart(lines, i);
  }

  function parseBlocks(lines, ctx, parent) {
    var i = 0;
    var m;
    while (i < lines.length) {
      var line = lines[i];
      if (isBlank(line)) { i += 1; continue; }

      if (RE_FENCE_OPEN.test(line)) {
        var buf = [];
        i += 1;
        while (i < lines.length && !RE_FENCE_CLOSE.test(lines[i])) { buf.push(lines[i]); i += 1; }
        i += 1; // the closing fence, or past the end when the file forgot it
        var pre = el("pre");
        var code = el("code");
        code.textContent = buf.join("\n");
        pre.appendChild(code);
        parent.appendChild(pre);
        continue;
      }

      if (!ctx.inQuote && (m = matchHeading(line))) {
        parent.appendChild(heading(m.level, m.text, ctx));
        i += 1;
        continue;
      }

      if (RE_HR.test(line)) { parent.appendChild(el("hr")); i += 1; continue; }

      if (!ctx.inQuote && RE_QUOTE.test(line)) {
        var inner = [];
        while (i < lines.length && (m = RE_QUOTE.exec(lines[i]))) { inner.push(m[1] || ""); i += 1; }
        parent.appendChild(callout(inner, ctx));
        continue;
      }

      if (isTableStart(lines, i)) { i = table(lines, i, parent); continue; }

      if (RE_UL.test(line) || RE_OL.test(line)) { i = list(lines, i, ctx, parent); continue; }

      // A PARAGRAPH: everything up to a blank line or the start of another
      // block, joined with single spaces.
      var para = [line.trim()];
      i += 1;
      while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i, ctx, true)) {
        para.push(lines[i].trim());
        i += 1;
      }
      var p = el("p");
      inline(para.join(" "), p, false, 0);
      parent.appendChild(p);
    }
  }

  function heading(level, text, ctx) {
    var h = el("h" + level);
    inline(text, h, false, 0);
    // THE ID COMES FROM WHAT THE READER SEES, not the source, so a link's URL
    // or a pair of backticks in a heading never ends up in its anchor.
    var plain = h.textContent;
    h.id = uniqueId(slug(plain), ctx.used, ctx.next);
    if (level === 1) {
      if (!ctx.title) ctx.title = plain;
    } else {
      ctx.headings.push({ level: level, id: h.id, text: plain, el: h });
    }
    return h;
  }

  function callout(inner, ctx) {
    var box = el("div", "callout");
    box.setAttribute("role", "note");
    var first = "";
    for (var k = 0; k < inner.length; k++) { if (!isBlank(inner[k])) { first = inner[k].trim(); break; } }
    var tone = RE_TONE.exec(first);
    if (tone) box.classList.add("tone-" + tone[1].toLowerCase());
    // The inside of a callout is ordinary blocks (paragraphs, lists, code),
    // except that it holds no headings and no second callout: a heading there
    // would put a line in the contents that points into a side note.
    var saved = ctx.inQuote;
    ctx.inQuote = true;
    parseBlocks(inner, ctx, box);
    ctx.inQuote = saved;
    return box;
  }

  function splitRow(line) {
    var s = line.trim();
    if (s.charAt(0) === "|") s = s.slice(1);
    if (s.charAt(s.length - 1) === "|" && s.charAt(s.length - 2) !== "\\") s = s.slice(0, -1);
    var cells = [];
    var cur = "";
    var inCode = false;
    for (var k = 0; k < s.length; k++) {
      var ch = s.charAt(k);
      // "\|" is a pipe inside a cell; a pipe inside a code span is too, so a
      // table can show a shell pipeline.
      if (ch === "\\" && s.charAt(k + 1) === "|") { cur += "|"; k += 1; continue; }
      if (ch === "`") {
        if (inCode) inCode = false;
        else if (s.indexOf("`", k + 1) > k) inCode = true;
      }
      if (ch === "|" && !inCode) { cells.push(cur.trim()); cur = ""; continue; }
      cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  }

  function table(lines, i, parent) {
    var head = splitRow(lines[i]);
    var aligns = splitRow(lines[i + 1]).map(function (c) {
      var l = c.charAt(0) === ":", r = c.charAt(c.length - 1) === ":";
      return l && r ? "center" : r ? "right" : l ? "left" : "";
    });
    var cols = head.length;
    var wrap = el("div", "tableWrap");
    var t = el("table");
    var thead = el("thead");
    var tr = el("tr");
    for (var c = 0; c < cols; c++) tr.appendChild(cell("th", head[c], aligns[c]));
    thead.appendChild(tr);
    t.appendChild(thead);
    var tbody = el("tbody");
    i += 2;
    while (i < lines.length && !isBlank(lines[i]) && RE_TABLE_ROW.test(lines[i])) {
      var row = splitRow(lines[i]);
      var r = el("tr");
      // Every row has the header's width: a short row is padded, a long one
      // loses what has no column to sit under.
      for (var k = 0; k < cols; k++) r.appendChild(cell("td", row[k] || "", aligns[k]));
      tbody.appendChild(r);
      i += 1;
    }
    t.appendChild(tbody);
    wrap.appendChild(t);
    parent.appendChild(wrap);
    return i;
  }

  function cell(tag, text, align) {
    var n = el(tag);
    if (align) n.style.textAlign = align;
    inline(text, n, false, 0);
    return n;
  }

  // LISTS. Items of one kind in a row make one list, blank lines between them
  // included, so a numbered list keeps counting across a spaced-out item. A
  // line indented two or more spaces continues the item above it (after a
  // blank line, as a new paragraph inside it). Nesting is not part of the
  // subset: an indented "- " is taken as the next item of the same list, so
  // a nested list is flattened instead of turning into stray dashes in text.
  function list(lines, i, ctx, parent) {
    var first = lines[i];
    var om = RE_OL.exec(first);
    var ordered = !!om && !RE_UL.test(first);
    var box = el(ordered ? "ol" : "ul");
    if (ordered && Number(om[2]) !== 1) box.start = Number(om[2]);
    var items = [];
    var cur = null;

    function sameKind(l) { return ordered ? RE_OL.exec(l) : RE_UL.exec(l); }
    function anyItem(l) { return RE_UL.exec(l) || RE_OL.exec(l); }

    while (i < lines.length) {
      var l = lines[i];
      // A FENCE ENDS THE LIST, indented or not. The comment pass has already
      // taken it for a fence, so reading it as item text here would print a
      // comment inside it, and would mangle the code into inline spans.
      if (RE_FENCE_OPEN.test(l)) break;
      if (isBlank(l)) {
        var j = i + 1;
        while (j < lines.length && isBlank(lines[j])) j += 1;
        if (j >= lines.length) { i = j; break; }
        var next = lines[j];
        if (indentOf(next) < 2 && sameKind(next)) { i = j; continue; }
        if (indentOf(next) >= 2 && cur) {
          if (!anyItem(next)) cur.push([]);
          i = j;
          continue;
        }
        break;
      }
      var ind = indentOf(l);
      var mk = ind < 2 ? sameKind(l) : anyItem(l);
      if (mk) {
        cur = [[mk[mk.length - 1].trim()]];
        items.push(cur);
        i += 1;
        continue;
      }
      if (ind < 2 && (anyItem(l) || startsBlock(lines, i, ctx, false))) break;
      // An indented line, or a plain line straight after an item, belongs to
      // the item's last paragraph.
      cur[cur.length - 1].push(l.trim());
      i += 1;
    }

    items.forEach(function (paras) {
      var li = el("li");
      var real = paras.filter(function (p) { return p.length; });
      if (real.length === 1) {
        inline(real[0].join(" "), li, false, 0);
      } else {
        real.forEach(function (p) {
          var pe = el("p");
          inline(p.join(" "), pe, false, 0);
          li.appendChild(pe);
        });
      }
      box.appendChild(li);
    });
    parent.appendChild(box);
    return i;
  }

  // ----------------------------------------------------------- inline pass

  // Finds the marker that closes an emphasis opened just before `from`.
  // Code spans are skipped whole because nothing inside one is markup.
  // THE SEARCH IS BOUNDED BY MAX_SPAN, because every "*" that never closes
  // would otherwise scan to the end of the paragraph: a long line of "*a"
  // froze the page for seconds. Bold or italic longer than that stays as
  // literal asterisks.
  function findClose(s, from, marker) {
    var stop = Math.min(s.length, from + MAX_SPAN);
    for (var k = from; k < stop; k++) {
      var ch = s.charAt(k);
      if (ch === "`") {
        var e = s.indexOf("`", k + 1);
        if (e > k + 1) k = e;
        else if (e === k + 1) k += 1;
        continue;
      }
      if (ch !== "*") continue;
      var before = s.charAt(k - 1);
      if (marker === "**") {
        if (s.charAt(k + 1) === "*" && !/\s/.test(before)) return k;
        if (s.charAt(k + 1) === "*") k += 1;
      } else {
        if (s.charAt(k + 1) === "*") { k += 1; continue; }
        if (!/\s/.test(before)) return k;
      }
    }
    return -1;
  }

  function linkTarget(url) {
    if (/^https?:\/\//i.test(url)) {
      if (/[\s<>"'`\\]/.test(url)) return null;
      var u;
      try { u = new URL(url); } catch (e) { return null; }
      if ((u.protocol !== "https:" && u.protocol !== "http:") || !u.hostname) return null;
      return { href: u.href, external: true };
    }
    if (RE_ANCHOR_LINK.test(url)) return { href: url, external: false };
    var m = RE_PAGE_LINK.exec(url);
    if (!m) return null;
    return { href: withConfig(m[1]) + (m[2] || ""), external: false };
  }

  // ANOTHER PAGE OF THE SITE KEEPS THE RPC PAIR the reader arrived with, the
  // way the bar's own links do. The bar's answer is only taken when it is
  // still that same page with a query on it; anything else and the bare file
  // name is used, so a link here can never be pointed off the site.
  function withConfig(page) {
    try {
      var bar = window.CurbBar;
      if (bar && typeof bar.withConfig === "function") {
        var out = bar.withConfig(page);
        if (typeof out === "string" && (out === page || out.indexOf(page + "?") === 0) &&
            !/[\s<>"'`#\\]/.test(out)) return out;
      }
    } catch (e) { /* the bar is optional here */ }
    return page;
  }

  // The ")" that closes a link target opened at `from`. Parentheses inside it
  // are counted, so "(https://en.wikipedia.org/wiki/Base_(chain))" keeps its
  // last ")" instead of leaving it behind as text. The scan gives up after
  // MAX_URL characters (-1: not a link), so it stays linear on hostile text.
  function closeParen(s, from) {
    var depth = 0;
    var stop = Math.min(s.length, from + MAX_URL);
    for (var k = from; k < stop; k++) {
      var ch = s.charAt(k);
      if (ch === "(") depth += 1;
      else if (ch === ")") { if (depth === 0) return k; depth -= 1; }
    }
    return -1;
  }

  function inline(s, parent, noLinks, depth) {
    var buf = "";
    function flush() {
      if (buf) { parent.appendChild(document.createTextNode(buf)); buf = ""; }
    }
    var i = 0;
    var n = s.length;
    while (i < n) {
      var c = s.charAt(i);

      if (c === "`") {
        var e = s.indexOf("`", i + 1);
        if (e > i + 1) {
          flush();
          var code = el("code");
          code.textContent = s.slice(i + 1, e);
          parent.appendChild(code);
          i = e + 1;
          continue;
        }
        if (e === i + 1) { buf += "``"; i += 2; continue; }
        buf += c; i += 1;
        continue;
      }

      if (c === "*" && depth < MAX_DEPTH) {
        if (s.charAt(i + 1) === "*") {
          var cb = /\S/.test(s.charAt(i + 2)) ? findClose(s, i + 3, "**") : -1;
          if (cb > 0) {
            flush();
            var b = el("strong");
            inline(s.slice(i + 2, cb), b, noLinks, depth + 1);
            parent.appendChild(b);
            i = cb + 2;
            continue;
          }
          buf += "**"; i += 2;
          continue;
        }
        var ci = /\S/.test(s.charAt(i + 1)) ? findClose(s, i + 2, "*") : -1;
        if (ci > 0) {
          flush();
          var em = el("em");
          inline(s.slice(i + 1, ci), em, noLinks, depth + 1);
          parent.appendChild(em);
          i = ci + 1;
          continue;
        }
        buf += c; i += 1;
        continue;
      }

      if (c === "[" && !noLinks) {
        var rb = s.indexOf("]", i + 1);
        if (rb > i + 1 && s.charAt(rb + 1) === "(") {
          var rp = closeParen(s, rb + 2);
          if (rp > rb + 2) {
            var target = linkTarget(s.slice(rb + 2, rp).trim());
            if (target) {
              flush();
              var a = el("a");
              a.setAttribute("href", target.href);
              if (target.external) {
                a.setAttribute("target", "_blank");
                a.setAttribute("rel", "noopener noreferrer");
              }
              inline(s.slice(i + 1, rb), a, true, depth + 1);
              parent.appendChild(a);
              i = rp + 1;
              continue;
            }
            // NOT ONE OF THE ALLOWED FORMS: the whole thing stays as it was
            // written, so the author sees the link that did not take.
            buf += s.slice(i, rp + 1);
            i = rp + 1;
            continue;
          }
        }
      }

      buf += c;
      i += 1;
    }
    flush();
  }

  // ---------------------------------------------------------------- render

  // Pure: builds the article into a fragment and touches nothing on the page.
  // Returns the "# " title, the "##"/"###" headings for the contents, and the
  // fragment itself. `taken` lists ids already on the page (the bar's, this
  // page's own), which a heading must not repeat: a duplicate id would send an
  // anchor jump to whichever element comes first.
  function render(md, taken) {
    var text = String(md == null ? "" : md).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    var lines = stripComments(text.split("\n"));
    var ctx = { headings: [], used: Object.create(null), next: Object.create(null), title: "", inQuote: false };
    RESERVED_IDS.concat(taken || []).forEach(function (id) { ctx.used[String(id)] = true; });
    var fragment = document.createDocumentFragment();
    parseBlocks(lines, ctx, fragment);
    return { title: ctx.title, headings: ctx.headings, fragment: fragment };
  }

  window.CurbDocs = { render: render, slug: slug };

  // ------------------------------------------------------------------ page

  function boot() {
    var article = document.getElementById("docArticle");
    if (!article) return; // loaded by a test page, which only wants render/slug
    var layout = document.getElementById("docLayout");
    var tocBox = document.getElementById("docToc");
    var tocList = document.getElementById("docTocList");
    var wide = window.matchMedia ? window.matchMedia("(min-width: 980px)") : null;

    function clear() { while (article.firstChild) article.removeChild(article.firstChild); }

    function show(md) {
      // Every id on the page before the article is drawn: the bar's, and this
      // page's own (the article holds only its loading line at this point).
      var taken = [];
      var withId = document.querySelectorAll("[id]");
      for (var k = 0; k < withId.length; k++) taken.push(withId[k].id);
      var out = render(md, taken);
      clear();
      if (!out.fragment.childNodes.length) {
        var empty = el("p", "docStatus");
        empty.textContent = "The docs file is empty.";
        article.appendChild(empty);
      } else {
        article.appendChild(out.fragment);
      }
      article.setAttribute("aria-busy", "false");
      document.title = out.title ? out.title + " — Curb Docs" : "Curb Docs";
      var links = buildToc(out.headings);
      watch(out.headings, links);
      jumpToHash();
    }

    function fail(err) {
      clear();
      article.setAttribute("aria-busy", "false");
      if (layout) layout.classList.add("noToc");
      // show() may have got as far as the contents before it threw; a list of
      // sections beside an error card would point at nothing.
      if (tocBox) tocBox.hidden = true;
      var box = el("div", "docError");
      box.setAttribute("role", "alert");
      var h = el("h1");
      h.textContent = "The docs could not be loaded.";
      box.appendChild(h);
      var why = el("p", "why");
      why.textContent = (err && err.message) ? err.message : String(err);
      box.appendChild(why);
      var hint = el("p");
      // THE COMMON CAUSE GETS NAMED, because a browser's own message for it
      // ("Failed to fetch") says nothing about what to do.
      if (err && err.status === 404) {
        // Served over http, so the "open it over http" advice would be wrong:
        // the file itself is missing.
        hint.textContent = "The server has no docs.md next to this page. It has to sit in the same folder " +
          "as docs.html.";
      } else if (location.protocol === "file:") {
        hint.textContent = "This page was opened as a file (file://), and browsers do not let a page read " +
          "docs.md from disk that way. Open it over http instead: serve the web folder with any static " +
          "file server and visit docs.html there.";
      } else {
        hint.textContent = "The docs are read from docs.md next to this page, so the page has to be opened " +
          "over http (not as a file:// path) from the same folder as docs.md. Reloading may help if the " +
          "server was briefly unavailable.";
      }
      box.appendChild(hint);
      article.appendChild(box);
    }

    function buildToc(headings) {
      var links = [];
      if (!tocBox || !tocList || !headings.length) {
        if (layout) layout.classList.add("noToc");
        return links;
      }
      headings.forEach(function (h, k) {
        var li = el("li", "lvl" + h.level);
        var a = el("a");
        a.setAttribute("href", "#" + h.id);
        a.textContent = h.text;
        a.addEventListener("click", function (e) {
          setActive(links, k);
          if (!wide || wide.matches) return;
          // ON A PHONE THE CONTENTS FOLD FIRST AND THE JUMP COMES AFTER. Folding
          // them after the browser's own jump would pull the page up by their
          // height and land the reader below the heading they asked for.
          e.preventDefault();
          tocBox.open = false;
          if (location.hash === "#" + h.id) h.el.scrollIntoView();
          else location.hash = h.id;
        });
        li.appendChild(a);
        tocList.appendChild(li);
        links.push(a);
      });
      tocBox.hidden = false;
      syncOpen();
      if (wide) {
        if (wide.addEventListener) wide.addEventListener("change", syncOpen);
        else if (wide.addListener) wide.addListener(syncOpen);
      }
      return links;
    }

    // Open whenever the screen is wide (the summary is hidden there, so it
    // could not be reopened by hand), folded whenever it turns narrow.
    function syncOpen() { tocBox.open = !wide || wide.matches; }

    var active = -1;
    function setActive(links, k) {
      if (k === active || !links.length) return;
      if (active >= 0 && links[active]) {
        links[active].classList.remove("on");
        links[active].removeAttribute("aria-current");
      }
      active = k;
      var a = links[k];
      if (!a) return;
      a.classList.add("on");
      a.setAttribute("aria-current", "true");
      // Keep the lit entry inside the sticky column when the contents are
      // longer than the window. Done by hand, because scrollIntoView could
      // move the page itself as well.
      if ((!wide || wide.matches) && tocBox.scrollHeight > tocBox.clientHeight) {
        var top = a.offsetTop, bottom = top + a.offsetHeight;
        if (top < tocBox.scrollTop || bottom > tocBox.scrollTop + tocBox.clientHeight) {
          tocBox.scrollTop = Math.max(0, top - tocBox.clientHeight / 3);
        }
      }
    }

    // THE SECTION IN VIEW is the last heading above a line 40% down the
    // window. The observer watches exactly that band (the top 40%), so it
    // fires whenever a heading crosses the line in either direction, and the
    // choice is then made from where the headings actually are.
    function watch(headings, links) {
      if (!links.length || !("IntersectionObserver" in window)) return;
      var els = headings.map(function (h) { return h.el; });
      function pick() {
        var line = window.innerHeight * 0.4 + 1;
        var cur = 0;
        for (var k = 0; k < els.length; k++) {
          if (els[k].getBoundingClientRect().top <= line) cur = k;
          else break;
        }
        setActive(links, cur);
      }
      var io = new IntersectionObserver(pick, { rootMargin: "0px 0px -60% 0px", threshold: [0, 1] });
      els.forEach(function (e) { io.observe(e); });
      pick();
    }

    // A LINK INTO THE DOCS lands on its section. The browser tried before the
    // headings existed, so it is done again once they do. Only ids inside the
    // article count, so a hash that matches something in the bar does nothing.
    function jumpToHash() {
      var want = "";
      try { want = decodeURIComponent(location.hash.slice(1)); } catch (e) { return; }
      if (!want) return;
      var all = article.querySelectorAll("[id]");
      for (var k = 0; k < all.length; k++) {
        if (all[k].id === want) {
          var target = all[k];
          window.requestAnimationFrame(function () { target.scrollIntoView(); });
          return;
        }
      }
    }

    if (typeof window.fetch !== "function") {
      fail(new Error("This browser cannot fetch files (no fetch())."));
      return;
    }
    window.fetch("docs.md", { cache: "no-store" }).then(function (r) {
      if (!r.ok) {
        var e = new Error("The server answered " + r.status + (r.statusText ? " " + r.statusText : "") +
          " for docs.md.");
        e.status = r.status;
        throw e;
      }
      return r.text();
    }, function (err) {
      throw new Error("Fetching docs.md failed: " + (err && err.message ? err.message : String(err)));
    }).then(show).catch(fail);
  }

  boot();
})();
