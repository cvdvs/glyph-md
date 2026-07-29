// The tab model that binds a file on disk to the page's tab id.
//
//   c++ -std=c++17 -Ishell Scripts/docs-smoke.cc -o /tmp/docs-smoke && /tmp/docs-smoke
//
// The property under test: whatever order files are opened, each tab ends up
// bound to ITS OWN file. The bug this replaces used a single shared slot that
// held only the last parked path, so opening two files at once bound the first
// tab's content to the second file's path — and the next save overwrote a
// different, untouched note. Every multi-open case here would have failed then.
#include "glyph_docs.h"

#include <cstdio>
#include <string>

static int fails = 0;
static void ok(const char *what, bool cond) {
  if (cond) std::printf("  ok    %s\n", what);
  else { ++fails; std::printf("  FAIL  %s\n", what); }
}

int main() {
  std::printf("two files opened at once bind to their OWN paths\n");
  {
    Tabs t;
    // pickOpen parks every selected path before any "opened" comes back.
    t.park("/notes/A.md");
    t.park("/notes/B.md");
    // The page mints ids and reports them in the same order.
    Doc *a = t.opened(2, "A.md");
    Doc *b = t.opened(3, "B.md");
    ok("first tab bound to the first file", a && a->path == "/notes/A.md" && a->id == 2);
    ok("second tab bound to the second file", b && b->path == "/notes/B.md" && b->id == 3);
    // The exact regression: with one slot, id 2 would have taken B's path.
    ok("first tab did NOT take the last parked path",
       a && a->path != "/notes/B.md");
    ok("nothing left parked", t.parked.empty());
    ok("both tabs findable by id", t.find(2) == a && t.find(3) == b);
  }

  std::printf("\nthree files, FIFO order preserved\n");
  {
    Tabs t;
    t.park("/x/one.md");
    t.park("/x/two.md");
    t.park("/x/three.md");
    Doc *d1 = t.opened(5, "one.md");
    Doc *d2 = t.opened(6, "two.md");
    Doc *d3 = t.opened(7, "three.md");
    ok("one", d1 && d1->path == "/x/one.md");
    ok("two", d2 && d2->path == "/x/two.md");
    ok("three", d3 && d3->path == "/x/three.md");
  }

  std::printf("\nreused tab consumes its token without a duplicate Doc\n");
  {
    Tabs t;
    t.park("/n/A.md");
    Doc *a = t.opened(2, "A.md");
    ok("opened once", a && a->path == "/n/A.md" && t.docs.size() == 1);
    // Opening the same file again: the page reuses tab 2 and reports it, having
    // parked one more path. The model must consume that token (or the queue
    // drifts) but NOT create a second Doc for id 2.
    t.park("/n/A.md");
    Doc *again = t.opened(2, "A.md");
    ok("reused tab makes no duplicate", again == nullptr && t.docs.size() == 1);
    ok("token was still consumed", t.parked.empty());
  }

  std::printf("\nedge cases\n");
  {
    Tabs t;
    ok("opened with nothing parked returns null", t.opened(9, "x") == nullptr);
    ok("find of an unknown id is null", t.find(42) == nullptr);
    t.park("/p/note.md");
    Doc *d = t.opened(4, "");  // page sent no name
    ok("empty name is left for the caller to fill", d && d->name.empty() && d->path == "/p/note.md");
  }

  std::printf("\n%s\n", fails ? "FAILURES" : "all pass");
  return fails ? 1 : 0;
}
