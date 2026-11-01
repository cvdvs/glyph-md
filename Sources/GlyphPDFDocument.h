#import <Cocoa/Cocoa.h>

// A PDF in a tab of its own. Read, never written.
@interface GlyphPDFDocument : NSDocument
@end

// What the read-only documents share: a window that joins the notes as a tab, and
// the rule for links inside something untrusted.
NSWindow *GlyphReaderWindow(id<NSToolbarDelegate> toolbarDelegate);
void GlyphOpenWebLink(NSURL *url);
