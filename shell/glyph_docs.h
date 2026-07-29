// The portable shell's tab model, kept apart from the webview so it can be
// tested on its own (Scripts/docs-smoke.cc).
//
// The subtle part is how a document on disk is bound to the tab the PAGE creates
// for it. The shell reads a file and asks the page to open it; the page mints
// its own tab id and reports it back in an "opened" message. The shell has to
// pair that id with the path it just read.
//
// The page issues opens in order and reports their ids back in that SAME order,
// so the oldest parked path is the one an "opened" belongs to — a FIFO queue.
// The earlier design used a single shared slot, which held only the LAST parked
// path: selecting two files in one Open dialog bound the first tab's content to
// the second file's path, and the next save overwrote a different, untouched
// note. That is the bug this model exists to make impossible, and to test.
#ifndef GLYPH_DOCS_H
#define GLYPH_DOCS_H

#include <deque>
#include <string>

struct Doc {
  int id = 0;
  std::string path;  // empty until saved
  std::string name;
};

class Tabs {
 public:
  // A deque, not a vector: opened() and find() hand out Doc* that callers use
  // across later opens, and a vector's push_back would reallocate and dangle
  // them. A deque never invalidates element pointers on push_back.
  std::deque<Doc> docs;
  std::deque<std::string> parked;  // paths handed to the page, awaiting their ids
  int active = 0;

  Doc *find(int id) {
    for (auto &d : docs) {
      if (d.id == id) return &d;
    }
    return nullptr;
  }

  void park(const std::string &path) { parked.push_back(path); }

  // Bind an "opened" id to the OLDEST parked path. Returns the newly-created
  // Doc, or nullptr when nothing is parked or the id is already bound (a reused
  // tab). A reused-tab id still CONSUMES its parked entry — that open produced
  // an "opened", so its token is spent — or the queue would drift by one and
  // every later binding would take the wrong path. `name` may be empty; the
  // caller fills it from the path (the model has no basename helper on purpose).
  Doc *opened(int id, const std::string &name) {
    if (parked.empty()) return nullptr;
    std::string path = parked.front();
    parked.pop_front();
    if (find(id)) return nullptr;  // already bound; token spent above
    docs.push_back(Doc{id, path, name});
    return &docs.back();
  }
};

#endif  // GLYPH_DOCS_H
