// The decoder that stands between the page and the user's file.
//
//   c++ -std=c++17 -Ishell Scripts/json-smoke.cc -o /tmp/json-smoke && /tmp/json-smoke
//
// The property under test is not "parses valid JSON". It is: whatever bytes the
// page holds, JSON.stringify them, decode them here, and get the SAME bytes
// back. A decoder that fails returns an empty string, and an empty string is
// what would be written over the note - so every case here is a file that would
// have been destroyed by the reader this one replaced.
#include "glyph_json.h"

#include <cstdio>
#include <string>
#include <vector>

static int fails = 0;

// What JSON.stringify does to a string, including the \uXXXX escapes the
// library's reader gives up on.
static std::string stringify(const std::string &s) {
  std::string out = "\"";
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof buf, "\\u%04x", c);
          out += buf;
        } else {
          out += static_cast<char>(c);
        }
    }
  }
  return out + "\"";
}

static void show(const std::string &s) {
  for (unsigned char c : s) {
    if (c < 0x20 || c == 0x7f) std::printf("\\x%02x", c);
    else std::printf("%c", c);
  }
}

// A note goes to the page and comes back as {"type":"save","text":<it>}.
static void round_trip(const char *what, const std::string &note) {
  std::string envelope = "[" + stringify("{\"type\":\"save\",\"text\":" +
                                         stringify(note) + "}") + "]";
  std::string payload, type, got;
  bool ok = json_first_element(envelope, &payload) &&
            json_field(payload, "type", &type) &&
            json_field(payload, "text", &got) && type == "save" && got == note;
  if (ok) {
    std::printf("  ok    %-38s %zu bytes\n", what, note.size());
  } else {
    fails++;
    std::printf("  FAIL  %-38s wanted [", what);
    show(note);
    std::printf("] got [");
    show(got);
    std::printf("]\n");
  }
}

static void expect(const char *what, bool cond) {
  if (cond) std::printf("  ok    %s\n", what);
  else { fails++; std::printf("  FAIL  %s\n", what); }
}

int main() {
  std::printf("a note survives the trip to the page and back\n");
  round_trip("plain prose", "# Title\n\nSome body text.\n");
  round_trip("quotes and backslashes", "He said \"no\" \\ again");
  round_trip("a tab", "a\tb");
  round_trip("CRLF line endings", "line one\r\nline two\r\n");

  // Every one of these came back as ZERO bytes from the library's reader.
  round_trip("U+001B, an ANSI colour paste", "\x1b[31mred\x1b[0m log line");
  round_trip("U+0007 BEL", "log\x07line");
  round_trip("U+000B vertical tab", "a\x0b" "b");
  round_trip("U+0000 NUL in the middle", std::string("a\0b", 3));
  round_trip("every control character", [] {
    std::string s;
    for (int c = 1; c < 0x20; ++c) s += static_cast<char>(c);
    return s;
  }());

  // The invisible characters rules 7, 20 and 30 depend on. These travel as raw
  // UTF-8 rather than as escapes, and must not be touched on the way through.
  round_trip("U+00A0 (rule 7)", "a\xc2\xa0" "b");
  round_trip("U+200B (rule 7)", "a\xe2\x80\x8b" "b");
  round_trip("U+2060 hard-break joiner (rule 30)", "a\xe2\x81\xa0" "b");
  round_trip("U+E000/U+E001 pipe marks (rule 20)", "a\xee\x80\x80" "b\xee\x80\x81" "c");
  round_trip("an em dash and a checkmark", "yes \xe2\x80\x94 \xe2\x9c\x93");
  round_trip("emoji outside the BMP", "\xf0\x9f\x93\x9d note");
  round_trip("Romanian diacritics", "\xc8\x99i \xc8\x9b\xc3\xa2n\xc4\x83");

  std::printf("\nsurrogates\n");
  {
    // A surrogate PAIR is one character above the BMP.
    std::string out;
    size_t i = 0;
    std::string src = "\"\\ud83d\\udcdd\"";
    expect("a surrogate pair decodes to one character",
           json_string(src, i, &out) && out == "\xf0\x9f\x93\x9d");
    // A LONE surrogate cannot be UTF-8. It becomes U+FFFD rather than failing,
    // because refusing here would refuse to save the whole document.
    i = 0;
    std::string lone = "\"x\\ud800y\"";
    expect("a lone surrogate becomes U+FFFD, not a failure",
           json_string(lone, i, &out) && out == "x\xef\xbf\xbdy");
  }

  std::printf("\nmalformed input is refused, never silently empty\n");
  {
    std::string out;
    size_t i = 0;
    std::string s = "\"unterminated";
    expect("an unterminated string fails", !json_string(s, i, &out));
    i = 0;
    s = "\"bad \\q escape\"";
    expect("an unknown escape fails", !json_string(s, i, &out));
    i = 0;
    s = "\"short \\u12\"";
    expect("a truncated \\u fails", !json_string(s, i, &out));
    expect("a missing field is not an empty field",
           !json_field("{\"type\":\"save\"}", "text", &out));
    expect("a field after a nested object is still found",
           json_field("{\"a\":{\"text\":\"wrong\"},\"text\":\"right\"}", "text", &out) &&
               out == "right");
    expect("a key appearing inside a STRING value is not mistaken for a field",
           json_field("{\"a\":\"\\\"text\\\":\\\"wrong\\\"\",\"text\":\"right\"}", "text",
                      &out) && out == "right");
    expect("a numeric field comes back raw",
           json_field("{\"id\":42,\"text\":\"x\"}", "id", &out) && out == "42");
    expect("an empty document is readable and stays empty",
           json_field("{\"text\":\"\"}", "text", &out) && out.empty());
  }

  std::printf("\n%s\n", fails ? "FAILURES" : "all pass");
  return fails ? 1 : 0;
}
