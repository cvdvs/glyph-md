// Glyph for Windows and Linux.
//
// The Mac app is a real AppKit document app: NSDocument, NSWindow tabs, an
// NSTextView for the raw editor. None of that exists here. What both builds
// share is Resources/viewer.html, which IS the interface - the renderer, the
// WYSIWYG editing layer, the serializer, and (behind window.__glyphChrome) a
// tab strip, toolbar and raw view written in the page itself.
//
// So this file is deliberately small. It owns files, windows and dialogs; the
// page owns everything the user sees. The rules it lives under:
//
//   - The page is loaded from a temp file:// URL, never set_html. Every backend
//     of the vendored library passes a NULL base URL to set_html, so a note's
//     relative image paths would resolve to nothing. Verified by reading the
//     header, not assumed.
//   - The CSP nonce must be real base64. A hand-written nonce is rejected and
//     the page's own scripts silently do not run, which looks exactly like a
//     broken build. Measured on WKWebView while designing this.
//   - webview_eval must run on the UI thread. Anything from another thread goes
//     through webview_dispatch. The autosave debounce is the reason this matters.
//   - The bytes of a note are never decoded. They are read, handed to the page
//     as UTF-8, and written back. No newline translation, ever - CRLF is the
//     user's choice and a note may contain U+00A0 that carries meaning.
// Before any include, because webview.h pulls in windows.h itself.
// windows.h defines min and max as MACROS, which turns every std::min in this
// file into "illegal token on right side of ::". Defining them alongside our
// own #include <windows.h> further down was too late - the header had already
// been through once. The build scripts pass /DNOMINMAX too.
#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#endif

#include "webview.h"

#include <algorithm>
#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

#include "glyph_json.h"
#include "resources.h"

#if defined(_WIN32)
#include <windows.h>
#include <commdlg.h>
#include <shellapi.h>
#include <shlobj.h>
#define GLYPH_PLATFORM "win"
#elif defined(__APPLE__)
#include <cstdlib>
#include <unistd.h>
#define GLYPH_PLATFORM "mac"
#else
#include <gtk/gtk.h>
#include <cstdlib>
#include <unistd.h>
#define GLYPH_PLATFORM "linux"
#endif

// ---------------------------------------------------------------- resources

static std::string resource(const char *name) {
  for (const glyph_resource_t *r = glyph_resources; r->name; ++r) {
    if (std::strcmp(r->name, name) == 0) {
      return std::string(reinterpret_cast<const char *>(r->data), r->len);
    }
  }
  return {};
}

// ---------------------------------------------------------------- utilities

static std::string replace_all(std::string s, const std::string &from,
                               const std::string &to) {
  if (from.empty()) return s;
  size_t at = 0;
  while ((at = s.find(from, at)) != std::string::npos) {
    s.replace(at, from.size(), to);
    at += to.size();
  }
  return s;
}

// A markdown document embedded in a <script> block. json_escape leaves "<"
// alone, so a note containing "</script>" would close the block and be parsed
// as HTML - running whatever it liked without ever passing the sanitizer. This
// is CLAUDE.md rule 13, and it is the same escape make-preview.py performs.
static std::string js_string(const std::string &s) {
  std::string out = "\"";
  for (size_t i = 0; i < s.size(); ++i) {
    unsigned char c = static_cast<unsigned char>(s[i]);
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      case '<': out += "\\u003c"; break;
      case '>': out += "\\u003e"; break;
      case '&': out += "\\u0026"; break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof buf, "\\u%04x", c);
          out += buf;
        } else {
          // Everything else, including every UTF-8 continuation byte, passes
          // through untouched. Re-encoding here is how invisible characters die.
          out += static_cast<char>(c);
        }
    }
  }
  // U+2028 and U+2029 terminate a string literal in older parsers.
  out = replace_all(out, "\xe2\x80\xa8", "\\u2028");
  out = replace_all(out, "\xe2\x80\xa9", "\\u2029");
  return out + "\"";
}

static std::string base64(const unsigned char *data, size_t n) {
  static const char *T =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  for (size_t i = 0; i < n; i += 3) {
    unsigned v = data[i] << 16;
    if (i + 1 < n) v |= data[i + 1] << 8;
    if (i + 2 < n) v |= data[i + 2];
    out += T[(v >> 18) & 63];
    out += T[(v >> 12) & 63];
    out += (i + 1 < n) ? T[(v >> 6) & 63] : '=';
    out += (i + 2 < n) ? T[v & 63] : '=';
  }
  return out;
}

// A fresh nonce per page load, so the page's own scripts run and anything a
// document injects does not. It MUST be base64: a hand-made value is rejected
// and every script in the page silently stops running.
static std::string make_nonce() {
  unsigned char bytes[16];
#if defined(_WIN32)
  for (size_t i = 0; i < sizeof bytes; ++i) {
    bytes[i] = static_cast<unsigned char>(rand() & 0xff);
  }
  // rand() is not good enough on its own; mix in values an attacker cannot see
  // and cannot replay. The nonce only has to be unguessable within one load.
  LARGE_INTEGER t;
  QueryPerformanceCounter(&t);
  for (size_t i = 0; i < sizeof bytes; ++i) {
    bytes[i] ^= static_cast<unsigned char>((t.QuadPart >> ((i % 8) * 8)) & 0xff);
    bytes[i] ^= static_cast<unsigned char>((GetCurrentProcessId() >> (i % 4)) & 0xff);
  }
#else
  FILE *f = std::fopen("/dev/urandom", "rb");
  if (f) {
    size_t got = std::fread(bytes, 1, sizeof bytes, f);
    std::fclose(f);
    if (got != sizeof bytes) f = nullptr;
  }
  if (!f) {
    for (size_t i = 0; i < sizeof bytes; ++i) bytes[i] = static_cast<unsigned char>(rand());
  }
#endif
  return base64(bytes, sizeof bytes);
}

#if defined(_WIN32)
// Every path in this file is UTF-8, because that is what the page speaks and
// what a .md file is written in. The ANSI Win32 functions do NOT take UTF-8:
// they take the machine's codepage, so a note in "Proiecte Clienti" spelled
// with the real diacritics - or any Cyrillic, Greek or CJK folder - would fail
// to open, with no error the user could act on. So the path crosses to UTF-16
// here and only the W functions are called.
static std::wstring widen(const std::string &s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  if (n <= 0) return {};
  std::wstring out(static_cast<size_t>(n), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), &out[0], n);
  return out;
}

static std::string narrow(const std::wstring &s) {
  if (s.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, s.data(), static_cast<int>(s.size()),
                              nullptr, 0, nullptr, nullptr);
  if (n <= 0) return {};
  std::string out(static_cast<size_t>(n), '\0');
  WideCharToMultiByte(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), &out[0], n,
                      nullptr, nullptr);
  return out;
}

// MSVC's fstream takes a wide path as an extension; this is the whole reason
// the standard library is usable here at all.
#define GLYPH_PATH(p) widen(p).c_str()
#else
#define GLYPH_PATH(p) (p).c_str()
#endif

static bool remove_file(const std::string &path) {
#if defined(_WIN32)
  return DeleteFileW(widen(path).c_str()) != 0;
#else
  return std::remove(path.c_str()) == 0;
#endif
}

static bool read_file(const std::string &path, std::string *out) {
  std::ifstream in(GLYPH_PATH(path), std::ios::binary);
  if (!in) return false;
  out->assign(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
  return true;
}

// Write to a sibling temp file and rename over the target, so a crash or a full
// disk cannot leave a half-written note where a whole one used to be.
static bool write_file_atomic(const std::string &path, const std::string &data) {
  std::string tmp = path + ".glyph-tmp";
  {
    std::ofstream out(GLYPH_PATH(tmp), std::ios::binary | std::ios::trunc);
    if (!out) return false;
    out.write(data.data(), static_cast<std::streamsize>(data.size()));
    out.flush();
    if (!out) { remove_file(tmp); return false; }
  }
#if defined(_WIN32)
  if (!MoveFileExW(widen(tmp).c_str(), widen(path).c_str(), MOVEFILE_REPLACE_EXISTING)) {
    remove_file(tmp);
    return false;
  }
#else
  if (std::rename(tmp.c_str(), path.c_str()) != 0) {
    remove_file(tmp);
    return false;
  }
#endif
  return true;
}

#if defined(_WIN32)
static const char SEP = '\\';
#else
static const char SEP = '/';
#endif

static bool is_sep(char c) { return c == '/' || c == '\\'; }

static std::string dir_of(const std::string &path) {
  size_t at = path.find_last_of("/\\");
  if (at == std::string::npos) return {};
  return path.substr(0, at);
}

static std::string base_of(const std::string &path) {
  size_t at = path.find_last_of("/\\");
  return at == std::string::npos ? path : path.substr(at + 1);
}

static std::string absolute_path(const std::string &path) {
#if defined(_WIN32)
  std::wstring w = widen(path);
  DWORD need = GetFullPathNameW(w.c_str(), 0, nullptr, nullptr);
  if (need == 0) return path;
  std::wstring buf(need, L'\0');
  DWORD n = GetFullPathNameW(w.c_str(), need, &buf[0], nullptr);
  if (n == 0 || n >= need) return path;
  buf.resize(n);
  return narrow(buf);
#else
  if (!path.empty() && path[0] == '/') return path;
  char buf[4096];
  if (!getcwd(buf, sizeof buf)) return path;
  return std::string(buf) + "/" + path;
#endif
}

// A file:// URL for the page's <img> to resolve against. Percent-encoding is
// not cosmetic: a folder called "Client Notes (2026)" would otherwise produce a
// URL the engine cannot parse, and every image in it would fail to appear.
static std::string file_url(const std::string &path, bool as_directory) {
  std::string p = absolute_path(path);
  std::string out = "file://";
#if defined(_WIN32)
  out += "/";  // file:///C:/...
#endif
  for (size_t i = 0; i < p.size(); ++i) {
    unsigned char c = static_cast<unsigned char>(p[i]);
    if (is_sep(static_cast<char>(c))) {
      out += '/';
    } else if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
               (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' ||
               c == '~' || c == ':') {
      out += static_cast<char>(c);
    } else {
      char buf[4];
      std::snprintf(buf, sizeof buf, "%%%02X", c);
      out += buf;
    }
  }
  if (as_directory && !out.empty() && out.back() != '/') out += '/';
  return out;
}

static std::string temp_dir() {
#if defined(_WIN32)
  wchar_t buf[MAX_PATH + 1];
  DWORD n = GetTempPathW(MAX_PATH + 1, buf);
  if (n > 0 && n <= MAX_PATH) {
    std::wstring w(buf, n);
    while (!w.empty() && (w.back() == L'\\' || w.back() == L'/')) w.pop_back();
    return narrow(w);
  }
  return ".";
#else
  const char *t = std::getenv("TMPDIR");
  if (!t || !*t) t = "/tmp";
  return std::string(t);
#endif
}

// ------------------------------------------------------------------- dialogs

// Returns chosen paths, empty if the user cancelled.
static std::vector<std::string> ask_open_paths(webview_t w);
static std::string ask_save_path(webview_t w, const std::string &suggested);
static void open_externally(const std::string &url);

#if defined(_WIN32)

static std::vector<std::string> ask_open_paths(webview_t w) {
  // Wide throughout: a Romanian folder name reaches this dialog as UTF-8 and
  // must come back as UTF-8, and the ANSI dialog would mangle both ends.
  std::vector<wchar_t> buf(64 * 1024, L'\0');
  OPENFILENAMEW ofn;
  std::memset(&ofn, 0, sizeof ofn);
  ofn.lStructSize = sizeof ofn;
  ofn.hwndOwner = static_cast<HWND>(webview_get_window(w));
  ofn.lpstrFilter = L"Markdown\0*.md;*.markdown;*.mdown;*.mkd\0All files\0*.*\0";
  ofn.lpstrFile = buf.data();
  ofn.nMaxFile = static_cast<DWORD>(buf.size());
  ofn.Flags = OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_ALLOWMULTISELECT |
              OFN_NOCHANGEDIR | OFN_HIDEREADONLY;
  std::vector<std::string> out;
  if (!GetOpenFileNameW(&ofn)) return out;
  // Multi-select gives "dir\0name1\0name2\0\0"; a single file is just the path.
  std::wstring first(buf.data());
  const wchar_t *p = buf.data() + first.size() + 1;
  if (*p == 0) {
    out.push_back(narrow(first));
  } else {
    while (*p) {
      out.push_back(narrow(first + L"\\" + p));
      p += wcslen(p) + 1;
    }
  }
  return out;
}

static std::string ask_save_path(webview_t w, const std::string &suggested) {
  std::vector<wchar_t> buf(4096, L'\0');
  std::wstring s = widen(suggested.empty() ? std::string("Untitled.md") : suggested);
  if (s.size() >= buf.size()) s.resize(buf.size() - 1);
  std::memcpy(buf.data(), s.c_str(), (s.size() + 1) * sizeof(wchar_t));
  OPENFILENAMEW ofn;
  std::memset(&ofn, 0, sizeof ofn);
  ofn.lStructSize = sizeof ofn;
  ofn.hwndOwner = static_cast<HWND>(webview_get_window(w));
  ofn.lpstrFilter = L"Markdown\0*.md;*.markdown\0All files\0*.*\0";
  ofn.lpstrFile = buf.data();
  ofn.nMaxFile = static_cast<DWORD>(buf.size());
  ofn.lpstrDefExt = L"md";
  ofn.Flags = OFN_EXPLORER | OFN_OVERWRITEPROMPT | OFN_NOCHANGEDIR;
  if (!GetSaveFileNameW(&ofn)) return {};
  return narrow(std::wstring(buf.data()));
}

static void open_externally(const std::string &url) {
  // Only http/https/mailto reach this, decided by action_for_url.
  ShellExecuteW(nullptr, L"open", widen(url).c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

#elif defined(__APPLE__)

// The macOS build of this shell exists so the Windows and Linux interface can
// be looked at on the only machine available. It is not the Mac app - that is
// the AppKit one in Sources/ - so it does not carry a second implementation of
// native dialogs. Pass a file on the command line to open it.
static std::vector<std::string> ask_open_paths(webview_t) { return {}; }
static std::string ask_save_path(webview_t, const std::string &) { return {}; }
static void open_externally(const std::string &url) {
  std::string cmd = "open " + url;  // preview build only
  (void)std::system(cmd.c_str());
}

#else

static std::vector<std::string> ask_open_paths(webview_t w) {
  std::vector<std::string> out;
  GtkWidget *dialog = gtk_file_chooser_dialog_new(
      "Open", GTK_WINDOW(webview_get_window(w)), GTK_FILE_CHOOSER_ACTION_OPEN,
      "_Cancel", GTK_RESPONSE_CANCEL, "_Open", GTK_RESPONSE_ACCEPT, nullptr);
  gtk_file_chooser_set_select_multiple(GTK_FILE_CHOOSER(dialog), TRUE);
  GtkFileFilter *filter = gtk_file_filter_new();
  gtk_file_filter_set_name(filter, "Markdown");
  gtk_file_filter_add_pattern(filter, "*.md");
  gtk_file_filter_add_pattern(filter, "*.markdown");
  gtk_file_filter_add_pattern(filter, "*.mdown");
  gtk_file_filter_add_pattern(filter, "*.mkd");
  gtk_file_chooser_add_filter(GTK_FILE_CHOOSER(dialog), filter);
  if (gtk_dialog_run(GTK_DIALOG(dialog)) == GTK_RESPONSE_ACCEPT) {
    GSList *names = gtk_file_chooser_get_filenames(GTK_FILE_CHOOSER(dialog));
    for (GSList *n = names; n; n = n->next) {
      out.push_back(static_cast<const char *>(n->data));
      g_free(n->data);
    }
    g_slist_free(names);
  }
  gtk_widget_destroy(dialog);
  // The dialog leaves events queued; drain them or the window stays smeared.
  while (gtk_events_pending()) gtk_main_iteration();
  return out;
}

static std::string ask_save_path(webview_t w, const std::string &suggested) {
  std::string out;
  GtkWidget *dialog = gtk_file_chooser_dialog_new(
      "Save As", GTK_WINDOW(webview_get_window(w)), GTK_FILE_CHOOSER_ACTION_SAVE,
      "_Cancel", GTK_RESPONSE_CANCEL, "_Save", GTK_RESPONSE_ACCEPT, nullptr);
  gtk_file_chooser_set_do_overwrite_confirmation(GTK_FILE_CHOOSER(dialog), TRUE);
  gtk_file_chooser_set_current_name(
      GTK_FILE_CHOOSER(dialog), suggested.empty() ? "Untitled.md" : suggested.c_str());
  if (gtk_dialog_run(GTK_DIALOG(dialog)) == GTK_RESPONSE_ACCEPT) {
    char *name = gtk_file_chooser_get_filename(GTK_FILE_CHOOSER(dialog));
    if (name) { out = name; g_free(name); }
  }
  gtk_widget_destroy(dialog);
  while (gtk_events_pending()) gtk_main_iteration();
  return out;
}

static void open_externally(const std::string &url) {
  // No shell: the URL comes from a document, and a document is untrusted.
  gchar *argv[] = {const_cast<gchar *>("xdg-open"),
                   const_cast<gchar *>(url.c_str()), nullptr};
  g_spawn_async(nullptr, argv, nullptr, G_SPAWN_SEARCH_PATH, nullptr, nullptr,
                nullptr, nullptr);
}

#endif

// --------------------------------------------------------------- URL policy

// The same three outcomes the Mac app allows, for the same reasons: a wiki is
// written with links between notes, and a link to a .command or .desktop file
// must never be handed to the system to launch. See CLAUDE.md rule 23.
enum UrlAction { kIgnore, kExternal, kOpenNote };

static bool has_markdown_extension(const std::string &p) {
  size_t dot = p.find_last_of('.');
  if (dot == std::string::npos) return false;
  std::string ext = p.substr(dot + 1);
  for (auto &c : ext) c = static_cast<char>(tolower(c));
  return ext == "md" || ext == "markdown" || ext == "mdown" || ext == "mkd";
}

static bool starts_with_ci(const std::string &s, const char *prefix) {
  size_t n = std::strlen(prefix);
  if (s.size() < n) return false;
  for (size_t i = 0; i < n; ++i) {
    if (tolower(static_cast<unsigned char>(s[i])) != tolower(static_cast<unsigned char>(prefix[i])))
      return false;
  }
  return true;
}

static UrlAction action_for_url(const std::string &url, const std::string &doc_dir,
                                std::string *note_out) {
  if (url.empty()) return kIgnore;
  if (starts_with_ci(url, "http://") || starts_with_ci(url, "https://") ||
      starts_with_ci(url, "mailto:")) {
    return kExternal;
  }
  // Anything else carrying a scheme is ignored outright - javascript:, file:,
  // data:, and every scheme nobody has thought of yet.
  size_t colon = url.find(':');
  size_t slash = url.find('/');
  if (colon != std::string::npos && (slash == std::string::npos || colon < slash)) {
    return kIgnore;
  }
  if (!has_markdown_extension(url)) return kIgnore;
  if (doc_dir.empty()) return kIgnore;
  std::string candidate = doc_dir + SEP + url;
  std::string body;
  if (!read_file(candidate, &body)) return kIgnore;
  *note_out = candidate;
  return kOpenNote;
}

// ------------------------------------------------------------------ the app

struct Doc {
  int id = 0;
  std::string path;  // empty until saved
  std::string name;
};

struct App {
  webview_t w = nullptr;
  FILE *log = nullptr;      // --selftest also writes here, see say()
  std::vector<Doc> docs;
  std::string page_path;   // the composed page in the temp folder
  std::string pending;     // last text the page sent for the active document
  int active = 0;
  std::string pending_open;  // path handed to the page, awaiting its id
  bool selftest = false;
  bool page_ready = false;
  int selftest_stage = 0;
  int selftest_failures = 0;
};

static App g;

// Selftest output goes to stdout AND to a file. On Windows this binary is a GUI
// app so no console follows the user around, and AttachConsole finds nothing to
// attach to on a CI runner - the first Windows run failed with not one line of
// output, which is not a thing anyone can debug. The file always works.
static void say(const char *fmt, ...) {
  va_list a;
  va_start(a, fmt);
  std::vfprintf(stdout, fmt, a);
  va_end(a);
  std::fflush(stdout);
  if (g.log) {
    va_start(a, fmt);
    std::vfprintf(g.log, fmt, a);
    va_end(a);
    std::fflush(g.log);
  }
}

static Doc *find_doc(int id) {
  for (auto &d : g.docs) {
    if (d.id == id) return &d;
  }
  return nullptr;
}

// Everything the page is told to do goes through here so it is escaped once.
static void call_page(const std::string &fn, const std::vector<std::string> &args) {
  std::string js = fn + "(";
  for (size_t i = 0; i < args.size(); ++i) {
    if (i) js += ",";
    js += args[i];
  }
  js += ")";
  webview_eval(g.w, js.c_str());
}

static void open_path_in_page(const std::string &path) {
  std::string text;
  if (!read_file(path, &text)) {
    std::fprintf(stderr, "glyph: cannot read %s\n", path.c_str());
    return;
  }
  std::string abs = absolute_path(path);
  // The PAGE mints document ids, in its own counter, and every later message
  // about this document carries the page's id. Inventing one here meant every
  // save missed its document and raised a Save-As for a file that already had
  // a perfectly good path on disk. So the path is parked and claimed by the id
  // the page reports back.
  g.pending_open = abs;
  call_page("window.__glyphOpened",
            {js_string(base_of(abs)), js_string(text),
             js_string(file_url(dir_of(abs), true))});
}

// ------------------------------------------------------------------ selftest

static void run_selftest_stage();

static void report_selftest(const std::string &name, const std::string &json) {
  bool ok = json.find("\"ok\":true") != std::string::npos;
  say("  %-10s %s\n", name.c_str(), ok ? "PASS" : "FAIL");
  if (!ok) {
    g.selftest_failures++;
    say("    %s\n", json.c_str());
  }
  if (name != "smoke") return;

  // The golden comparison. Every assertion above can pass while the serializer
  // quietly writes something different from what the Mac app writes, and that
  // difference would land in the owner's files rather than in a test. This is
  // the same byte-for-byte check CI runs against Blink and WKWebView.
  std::string got;
  json_field(json, "serialized", &got);
  std::string want = resource("golden_sample_md");
  if (got.empty()) {
    say("  %-10s NO SERIALIZATION RETURNED\n", "golden");
    g.selftest_failures++;
    return;
  }
  if (got == want) {
    say("  %-10s matches golden-sample.md exactly\n", "golden");
    return;
  }
  g.selftest_failures++;
  say("  %-10s DRIFTED from golden-sample.md (%zu bytes, expected %zu)\n",
      "golden", got.size(), want.size());
  // Print the first difference in full. A CI log is the only debugger anyone
  // gets here, so it has to say WHERE, not just that something moved.
  size_t at = 0;
  while (at < got.size() && at < want.size() && got[at] == want[at]) ++at;
  size_t line = 1;
  for (size_t i = 0; i < at && i < want.size(); ++i) {
    if (want[i] == '\n') ++line;
  }
  auto slice = [](const std::string &s, size_t from) {
    size_t end = s.find('\n', from);
    if (end == std::string::npos) end = s.size();
    return s.substr(from, std::min<size_t>(end - from, 90));
  };
  size_t bol = want.rfind('\n', at);
  bol = (bol == std::string::npos) ? 0 : bol + 1;
  say("             first difference at byte %zu, line %zu\n", at, line);
  say("             expected: %s\n", slice(want, bol).c_str());
  say("             actual:   %s\n", slice(got, std::min(bol, got.size())).c_str());
}

// A file whose NAME needs more than the machine's codepage, holding bytes that
// have to survive exactly. On Windows this is the entire point of the wide-path
// conversion: with the ANSI functions the file simply fails to open and the
// user is told nothing they can act on. It runs before the window exists,
// because it tests the shell's own file handling rather than anything in the
// page - and the escapes below are written as \x sequences on purpose, since a
// literal character here would not survive an editing tool (CLAUDE.md rule 7).
static bool selftest_files() {
  const std::string dir = temp_dir();
  // Romanian, because that is who this is for: t-comma, a-circumflex, a-breve,
  // and an em dash - none of which survive a codepage round trip.
  const std::string name =
      "Proiecte Clien\xc8\x9bi \xe2\x80\x94 \xc3\x8ensemn\xc4\x83ri.md";
  const std::string path = dir + SEP + name;
  // Content carrying the invisible characters rules 7, 20 and 30 depend on,
  // plus an ESC, which is what a pasted terminal log contains.
  const std::string body =
      "# \xc3\x8ensemn\xc4\x83ri\n\nnbsp:\xc2\xa0 zwsp:\xe2\x80\x8b "
      "joiner:\xe2\x81\xa0 esc:\x1b[31m\n\n- unu\n- doi\n";

  bool good = true;
  if (!write_file_atomic(path, body)) {
    say("  %-10s FAIL could not write %s\n", "files", path.c_str());
    return false;
  }
  std::string back;
  if (!read_file(path, &back)) {
    say("  %-10s FAIL could not read back %s\n", "files", path.c_str());
    good = false;
  } else if (back != body) {
    say("  %-10s FAIL %zu bytes written, %zu read back\n", "files",
        body.size(), back.size());
    good = false;
  }
  // The folder URL the page resolves images against has to survive it too.
  const std::string url = file_url(dir_of(path), true);
  if (url.compare(0, 7, "file://") != 0 || url.empty() || url.back() != '/') {
    say("  %-10s FAIL bad folder URL %s\n", "files", url.c_str());
    good = false;
  }
  if (base_of(path) != name) {
    say("  %-10s FAIL basename came back as %s\n", "files", base_of(path).c_str());
    good = false;
  }
  remove_file(path);
  if (good) {
    say("  %-10s PASS a file named in Romanian, read back byte-exact\n", "files");
  }
  return good;
}

// --------------------------------------------------------------- the bridge

static void on_page_message(const char *id, const char *req, void *) {
  // req is the argument array of the bound call; element 0 is our JSON.
  std::string payload, type;
  if (!json_first_element(std::string(req), &payload) ||
      !json_field(payload, "type", &type)) {
    std::fprintf(stderr, "glyph: unreadable message from the page, ignored\n");
    webview_return(g.w, id, 1, "\"bad message\"");
    return;
  }

  if (type == "ready") g.page_ready = true;

  if (type == "opened") {
    // The page has taken the document and given it an id. Bind the path to it.
    std::string ids, name;
    if (!json_field(payload, "id", &ids)) return;
    int docid = std::atoi(ids.c_str());
    json_field(payload, "name", &name);
    if (find_doc(docid) || g.pending_open.empty()) return;
    Doc d;
    d.id = docid;
    d.path = g.pending_open;
    d.name = name.empty() ? base_of(d.path) : name;
    g.docs.push_back(d);
    g.pending_open.clear();

  } else if (type == "active") {
    // Which tab is in front decides which folder a relative link resolves
    // against. Without this the shell answered for whichever document opened
    // first, and a link in the second note looked for its target beside the
    // first one.
    std::string ids;
    if (json_field(payload, "id", &ids)) g.active = std::atoi(ids.c_str());

  } else if (type == "ready") {
    // The interface is up. Nothing may be evaluated into the page before this.
    if (g.selftest) run_selftest_stage();

  } else if (type == "source") {
    json_field(payload, "text", &g.pending);

  } else if (type == "pickOpen") {
    for (const auto &p : ask_open_paths(g.w)) open_path_in_page(p);

  } else if (type == "save") {
    std::string text, name, ids;
    // A save whose text cannot be read is REFUSED. Writing what a failed parse
    // returns would replace the note with nothing, which is how a file dies.
    if (!json_field(payload, "text", &text)) {
      std::fprintf(stderr, "glyph: refusing to save - the document could not be "
                           "read back from the page\n");
      webview_return(g.w, id, 1, "\"unreadable document\"");
      return;
    }
    json_field(payload, "name", &name);
    json_field(payload, "id", &ids);
    int docid = ids.empty() ? 0 : std::atoi(ids.c_str());
    Doc *d = find_doc(docid);
    std::string path = d ? d->path : std::string();
    if (path.empty()) {
      path = ask_save_path(g.w, name.empty() ? "Untitled.md" : name);
      if (path.empty()) return;  // cancelled
    }
    if (!write_file_atomic(path, text)) {
      std::fprintf(stderr, "glyph: could not write %s\n", path.c_str());
      return;
    }
    if (!d) {
      Doc nd;
      nd.id = docid;
      g.docs.push_back(nd);
      d = &g.docs.back();
    }
    d->path = path;
    d->name = base_of(path);
    call_page("window.__glyphSaved",
              {std::to_string(docid), js_string(d->name),
               js_string(file_url(dir_of(path), true))});

  } else if (type == "openURL") {
    std::string url;
    json_field(payload, "url", &url);
    Doc *d = find_doc(g.active);
    std::string doc_dir = d && !d->path.empty() ? dir_of(d->path) : std::string();
    std::string note;
    switch (action_for_url(url, doc_dir, &note)) {
      case kExternal: open_externally(url); break;
      case kOpenNote: open_path_in_page(note); break;
      case kIgnore: break;
    }

  } else if (type == "openWikilink") {
    // Resolution lives in the Mac app's GlyphVault. Until that is ported, a
    // wikilink that names a sibling file opens; anything else is ignored,
    // which is the safe half of the behaviour rather than a wrong guess.
    std::string target;
    json_field(payload, "target", &target);
    Doc *d = find_doc(g.active);
    if (!d || d->path.empty() || target.empty()) return;
    // A target is a NAME, never a path (CLAUDE.md rule 29).
    size_t cut = target.find_last_of("/\\:");
    if (cut != std::string::npos) target = target.substr(cut + 1);
    size_t bar = target.find_first_of("|#^");
    if (bar != std::string::npos) target = target.substr(0, bar);
    if (target.empty() || target == "." || target == "..") return;
    for (const char *ext : {".md", ".markdown", ".mdown", ".mkd"}) {
      std::string candidate = dir_of(d->path) + SEP + target + ext;
      std::string body;
      if (read_file(candidate, &body)) { open_path_in_page(candidate); return; }
    }

  } else if (type == "selftest") {
    std::string name, result;
    json_field(payload, "name", &name);
    json_field(payload, "result", &result);
    report_selftest(name, result);
    g.selftest_stage++;
    run_selftest_stage();
  }

  webview_return(g.w, id, 0, "null");
}

// The suites are the same files the Mac app and headless Chrome run, so a
// difference between engines shows up here rather than in a user's document.
static void run_selftest_stage() {
  struct Stage { const char *name; const char *res; const char *doc; };
  static const Stage stages[] = {
      {"smoke", "smoke_js", "sample_md"},
      {"security", "security_smoke_js", "hostile_md"},
      {"fidelity", "fidelity_smoke_js", "fidelity_md"},
  };
  const int n = static_cast<int>(sizeof stages / sizeof stages[0]);
  if (g.selftest_stage >= n) {
    say("%s\n", g.selftest_failures ? "SELFTEST FAILED" : "selftest: all pass");
    webview_terminate(g.w);
    return;
  }
  const Stage &s = stages[g.selftest_stage];
  std::string doc = resource(s.doc);
  std::string suite = resource(s.res);
  // Render the fixture, run the suite, and hand the result back through the
  // same bridge the interface uses - so the bridge is under test too.
  std::string js =
      "(function(){ try {"
      "  window.__glyphDocDir = null;"
      "  window.renderMarkdown(" + js_string(doc) + ");"
      "  var out = " + suite + ";"
      "  window.__glyphNative(JSON.stringify({type:'selftest',name:" +
      js_string(s.name) + ",result: out}));"
      "} catch (e) {"
      "  window.__glyphNative(JSON.stringify({type:'selftest',name:" +
      js_string(s.name) + ",result: JSON.stringify({ok:false,threw:String(e)})}));"
      "} })()";
  webview_eval(g.w, js.c_str());
}

// -------------------------------------------------------- platform tidying

#if defined(_WIN32)
// The binary is a GUI subsystem app, so no console window trails the user
// around. --selftest still has to be readable, and in CI the log IS the only
// debugger, so it borrows the console that launched it.
static void attach_parent_console() {
  if (!AttachConsole(ATTACH_PARENT_PROCESS)) return;
  FILE *f = nullptr;
  freopen_s(&f, "CONOUT$", "w", stdout);
  freopen_s(&f, "CONOUT$", "w", stderr);
}

// Settings that have to be off in a document editor.
//
// AreBrowserAcceleratorKeysEnabled is the one that matters: with it on, Ctrl+R
// reloads the page. In a browser that is harmless; here it throws away every
// unsaved edit in every tab, silently, on a keystroke people press by reflex.
// Ctrl+P, Ctrl+F and Ctrl+- likewise belong to the document, not to the engine.
static void tame_webview2(webview_t w) {
  auto *controller = static_cast<ICoreWebView2Controller *>(
      webview_get_native_handle(w, WEBVIEW_NATIVE_HANDLE_KIND_BROWSER_CONTROLLER));
  if (!controller) return;
  ICoreWebView2 *core = nullptr;
  if (FAILED(controller->get_CoreWebView2(&core)) || !core) return;
  ICoreWebView2Settings *settings = nullptr;
  if (SUCCEEDED(core->get_Settings(&settings)) && settings) {
    settings->put_AreDefaultContextMenusEnabled(FALSE);
    settings->put_IsZoomControlEnabled(FALSE);
    settings->put_IsStatusBarEnabled(FALSE);
    settings->put_AreDevToolsEnabled(FALSE);
    // Only on newer runtimes; an older one simply keeps the browser keys, which
    // is a worse editor but not a broken one.
    ICoreWebView2Settings3 *s3 = nullptr;
    if (SUCCEEDED(settings->QueryInterface(IID_PPV_ARGS(&s3))) && s3) {
      s3->put_AreBrowserAcceleratorKeysEnabled(FALSE);
      s3->Release();
    }
    settings->Release();
  }
  core->Release();
}
#endif

// ------------------------------------------------------------------- startup

static std::string compose_page(const std::string &initial_name,
                                const std::string &initial_text,
                                const std::string &initial_dir) {
  std::string html = resource("viewer_html");
  std::string marked = resource("marked_js");
  html = replace_all(html, "/*__MARKED_JS__*/", marked);

  std::string initial =
      "window.__glyphChrome = true;\n"
      "window.__glyphPlatform = \"" GLYPH_PLATFORM "\";\n"
      "window.__initialName = " + js_string(initial_name) + ";\n"
      "window.__initialDir = " + (initial_dir.empty() ? "null" : js_string(initial_dir)) + ";\n"
      "window.__glyphDocDir = window.__initialDir;\n"
      "window.__initial = " + js_string(initial_text) + ";";
  html = replace_all(html, "/*__INITIAL__*/", initial);

  // A nonce, not hashes: the page is composed fresh for this process, so there
  // is a per-load step to put one in. It must be real base64 or nothing runs.
  std::string nonce = make_nonce();
  html = replace_all(html, "/*__CSP_NONCE__*/", nonce);
  html = replace_all(html, "'/*__CSP_SCRIPT__*/'", "'nonce-" + nonce + "'");
  html = replace_all(html, "'/*__CSP_STYLE__*/'", "'nonce-" + nonce + "'");
  return html;
}

int main(int argc, char **argv) {
#if defined(_WIN32)
  for (int i = 1; i < argc; ++i) {
    if (std::strcmp(argv[i], "--selftest") == 0 ||
        std::strcmp(argv[i], "--version") == 0) {
      attach_parent_console();
      break;
    }
  }
#endif
#if !defined(_WIN32) && !defined(__APPLE__)
  gtk_init_check(&argc, &argv);
#endif

  std::string open_path;
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    if (a == "--selftest") {
      g.selftest = true;
      g.log = std::fopen("glyph-selftest.log", "w");
    } else if (a == "--version") {
      std::printf("Glyph portable shell, webview %d.%d.%d\n",
                  webview_version()->version.major, webview_version()->version.minor,
                  webview_version()->version.patch);
      return 0;
    } else if (!a.empty() && a[0] != '-') {
      open_path = a;
    }
  }

  std::string name = "Untitled.md", text, dir;
  if (!open_path.empty()) {
    if (!read_file(open_path, &text)) {
      std::fprintf(stderr, "glyph: cannot read %s\n", open_path.c_str());
      return 1;
    }
    std::string abs = absolute_path(open_path);
    name = base_of(abs);
    dir = file_url(dir_of(abs), true);
    Doc d;
    d.id = 1;  // the page numbers its first document 1
    d.path = abs;
    d.name = name;
    g.docs.push_back(d);
    g.active = 1;
  } else {
    g.active = 1;
  }

  std::string html = compose_page(name, text, dir);
  g.page_path = temp_dir() + SEP + "glyph-page.html";
  if (!write_file_atomic(g.page_path, html)) {
    std::fprintf(stderr, "glyph: cannot write the interface to %s\n", g.page_path.c_str());
    return 1;
  }

  g.w = webview_create(0, nullptr);
  if (!g.w) {
    // On Windows this is a machine with no Evergreen WebView2 runtime. Every
    // call below would dereference null, so say what is wrong instead.
    say("glyph: could not create the web view.\n"
#if defined(_WIN32)
        "This needs the Microsoft Edge WebView2 runtime, which is on Windows 11\n"
        "and most Windows 10 machines already. Install it from\n"
        "https://developer.microsoft.com/microsoft-edge/webview2/\n"
#else
        "This needs WebKitGTK (libwebkit2gtk-4.1-0) and a running display.\n"
#endif
    );
    return 1;
  }
  webview_set_title(g.w, "Glyph");
  webview_set_size(g.w, 1000, 800, WEBVIEW_HINT_NONE);
  webview_bind(g.w, "__glyphNative", on_page_message, nullptr);
#if defined(_WIN32)
  tame_webview2(g.w);
#endif
  webview_navigate(g.w, file_url(g.page_path, false).c_str());

  if (g.selftest) {
    say("glyph selftest (" GLYPH_PLATFORM ")\n");
    if (!selftest_files()) g.selftest_failures++;
  }
  // The selftest starts when the page reports "ready", not on a timer.

  webview_run(g.w);
  webview_destroy(g.w);
  remove_file(g.page_path);

  // A selftest that never heard from the page is a FAILURE, and it needs to say
  // which half broke: the window closing on its own with nothing reported is
  // otherwise indistinguishable from a suite failing, and both just exit 1.
  if (g.selftest && !g.page_ready) {
    say("SELFTEST FAILED: the interface never reported ready.\n"
        "The window opened and closed without the page loading. Usually the\n"
        "engine could not start, or it could not read the composed page at\n"
        "%s\n", g.page_path.c_str());
    g.selftest_failures++;
  }
  if (g.log) std::fclose(g.log);
  return g.selftest_failures ? 1 : 0;
}
