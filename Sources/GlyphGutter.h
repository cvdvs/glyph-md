// Line numbers for the raw editor, drawn flush against the page rather than in a
// tinted rail — the way Cursor, VS Code and Obsidian do it.
//
// Numbers are LOGICAL: one per paragraph. A soft-wrapped paragraph gets its
// number on the first display line and nothing on the continuations, which is
// what makes the gutter meaningful in a document full of long prose lines.
#import <Cocoa/Cocoa.h>

@class GlyphHighlighter;

NS_ASSUME_NONNULL_BEGIN

@interface GlyphGutter : NSRulerView

- (instancetype)initWithTextView:(NSTextView *)textView
                     highlighter:(GlyphHighlighter *)highlighter;

// Recompute width (digit count) and repaint. Cheap; safe to call after any edit.
- (void)refresh;

@end

NS_ASSUME_NONNULL_END
