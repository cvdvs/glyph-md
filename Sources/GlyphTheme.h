// The raw editor's palette and typography, kept in lockstep with the CSS custom
// properties in Resources/viewer.html so both views of a document agree: an H2 is
// gold in the formatted view and gold in the source.
//
// Every color is an unresolved dynamic NSColor. TextKit resolves them at draw
// time, so View > Appearance flips the whole raw view for free. Never call
// -colorUsingColorSpace: on one — that freezes it to whatever mode was current.
#import <Cocoa/Cocoa.h>

NS_ASSUME_NONNULL_BEGIN

// Base
NSColor *GlyphBG(void);          // --bg      page + gutter background
NSColor *GlyphFG(void);          // --fg      default text
NSColor *GlyphMuted(void);       // --muted   renders, but quietly
NSColor *GlyphFaint(void);       // --faint   punctuation that vanishes when rendered
NSColor *GlyphAccent(void);      // --accent  caret, checked box, frontmatter values
NSColor *GlyphCodeBG(void);      // --code-bg inline code chip

// Content colors, matching the formatted view exactly
NSColor *GlyphH1(void);
NSColor *GlyphH2(void);
NSColor *GlyphH3(void);
NSColor *GlyphH4(void);
NSColor *GlyphLink(void);
NSColor *GlyphQuote(void);
NSColor *GlyphHighlightBG(void); // ==mark== background
NSColor *GlyphTagColor(NSString *tag);      // same hash-to-palette rule as viewer.html
NSColor *GlyphCalloutColor(NSString *type); // note/tip/warning/danger/...

// Typography
NSFont *GlyphMonoFont(void);
NSFont *GlyphMonoBoldFont(void);
NSParagraphStyle *GlyphBaseParagraphStyle(void);
NSDictionary<NSAttributedStringKey, id> *GlyphBaseAttributes(void);

// An NSTextView that refuses to inherit color from the character before the
// caret. Without this, typing after a colored token continues in that token's
// color until the highlighter catches up — the single most visible defect.
@interface GlyphTextView : NSTextView
@end

NS_ASSUME_NONNULL_END
