// Reading JSON that came from the page.
//
// The vendored library ships a JSON reader, and it CANNOT be used for a
// document. Its unescaper handles \b \f \n \r \t \\ \/ \" and then:
//
//     default: // TODO: support unicode decoding
//       return -1;
//
// JSON.stringify emits \uXXXX for every control character except those five,
// so a note containing an ESC - every ANSI colour code in pasted terminal
// output - makes the parse fail and return an empty string. The save path would
// then write that empty string over the note. Measured with the library's own
// reader: U+0007, U+000B, U+001B and a lone surrogate all came back as zero
// bytes, and the note they came from would have been replaced with nothing.
//
// So Glyph decodes JSON strings itself, with surrogate pairs, and a failed
// decode is an ERROR that refuses the write rather than an empty document.
//
// Scripts/json-smoke.cc is the test and runs in CI.
#ifndef GLYPH_JSON_H
#define GLYPH_JSON_H

#include <cstddef>
#include <string>

static void utf8_append(std::string &out, unsigned cp) {
  if (cp <= 0x7f) {
    out += static_cast<char>(cp);
  } else if (cp <= 0x7ff) {
    out += static_cast<char>(0xc0 | (cp >> 6));
    out += static_cast<char>(0x80 | (cp & 0x3f));
  } else if (cp <= 0xffff) {
    out += static_cast<char>(0xe0 | (cp >> 12));
    out += static_cast<char>(0x80 | ((cp >> 6) & 0x3f));
    out += static_cast<char>(0x80 | (cp & 0x3f));
  } else {
    out += static_cast<char>(0xf0 | (cp >> 18));
    out += static_cast<char>(0x80 | ((cp >> 12) & 0x3f));
    out += static_cast<char>(0x80 | ((cp >> 6) & 0x3f));
    out += static_cast<char>(0x80 | (cp & 0x3f));
  }
}

static bool hex4(const std::string &s, size_t at, unsigned *v) {
  if (at + 4 > s.size()) return false;
  unsigned r = 0;
  for (int k = 0; k < 4; ++k) {
    char c = s[at + k];
    r <<= 4;
    if (c >= '0' && c <= '9') r |= static_cast<unsigned>(c - '0');
    else if (c >= 'a' && c <= 'f') r |= static_cast<unsigned>(c - 'a' + 10);
    else if (c >= 'A' && c <= 'F') r |= static_cast<unsigned>(c - 'A' + 10);
    else return false;
  }
  *v = r;
  return true;
}

static void json_skip_ws(const std::string &s, size_t &i) {
  while (i < s.size() && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) ++i;
}

static bool json_string(const std::string &s, size_t &i, std::string *out) {
  json_skip_ws(s, i);
  if (i >= s.size() || s[i] != '"') return false;
  ++i;
  out->clear();
  while (i < s.size()) {
    unsigned char c = static_cast<unsigned char>(s[i]);
    if (c == '"') { ++i; return true; }
    if (c != '\\') { *out += static_cast<char>(c); ++i; continue; }
    ++i;
    if (i >= s.size()) return false;
    char e = s[i++];
    switch (e) {
      case '"': *out += '"'; break;
      case '\\': *out += '\\'; break;
      case '/': *out += '/'; break;
      case 'b': *out += '\b'; break;
      case 'f': *out += '\f'; break;
      case 'n': *out += '\n'; break;
      case 'r': *out += '\r'; break;
      case 't': *out += '\t'; break;
      case 'u': {
        unsigned cp = 0;
        if (!hex4(s, i, &cp)) return false;
        i += 4;
        if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.size() &&
            s[i] == '\\' && s[i + 1] == 'u') {
          unsigned lo = 0;
          if (hex4(s, i + 2, &lo) && lo >= 0xdc00 && lo <= 0xdfff) {
            i += 6;
            cp = 0x10000u + ((cp - 0xd800u) << 10) + (lo - 0xdc00u);
          }
        }
        // A lone surrogate cannot be encoded as UTF-8. Substituting U+FFFD is
        // what every browser does, and it keeps the rest of the note - failing
        // here would refuse to save a document over one broken character.
        if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
        utf8_append(*out, cp);
        break;
      }
      default:
        return false;
    }
  }
  return false;
}

// Step over one value, so the key scan can reach the next pair.
static bool json_skip_value(const std::string &s, size_t &i) {
  json_skip_ws(s, i);
  if (i >= s.size()) return false;
  char c = s[i];
  if (c == '"') { std::string ignored; return json_string(s, i, &ignored); }
  if (c == '{' || c == '[') {
    char open = c, close = (c == '{') ? '}' : ']';
    int depth = 0;
    while (i < s.size()) {
      char d = s[i];
      if (d == '"') { std::string ignored; if (!json_string(s, i, &ignored)) return false; continue; }
      if (d == open) ++depth;
      else if (d == close) { --depth; if (depth == 0) { ++i; return true; } }
      ++i;
    }
    return false;
  }
  while (i < s.size() && s[i] != ',' && s[i] != '}' && s[i] != ']') ++i;
  return true;
}

// The string value of `key` in a JSON object. False if absent or malformed -
// which is never treated as "empty".
static bool json_field(const std::string &obj, const std::string &key, std::string *out) {
  size_t i = 0;
  json_skip_ws(obj, i);
  if (i >= obj.size() || obj[i] != '{') return false;
  ++i;
  while (i < obj.size()) {
    json_skip_ws(obj, i);
    if (i < obj.size() && obj[i] == '}') return false;
    std::string k;
    if (!json_string(obj, i, &k)) return false;
    json_skip_ws(obj, i);
    if (i >= obj.size() || obj[i] != ':') return false;
    ++i;
    if (k == key) {
      json_skip_ws(obj, i);
      if (i < obj.size() && obj[i] == '"') return json_string(obj, i, out);
      // A non-string value (the document id is a number) is returned raw.
      size_t start = i;
      if (!json_skip_value(obj, i)) return false;
      *out = obj.substr(start, i - start);
      return true;
    }
    if (!json_skip_value(obj, i)) return false;
    json_skip_ws(obj, i);
    if (i < obj.size() && obj[i] == ',') ++i;
  }
  return false;
}

// Element 0 of the argument array webview hands a bound function.
static bool json_first_element(const std::string &arr, std::string *out) {
  size_t i = 0;
  json_skip_ws(arr, i);
  if (i >= arr.size() || arr[i] != '[') return false;
  ++i;
  return json_string(arr, i, out);
}


#endif  // GLYPH_JSON_H
