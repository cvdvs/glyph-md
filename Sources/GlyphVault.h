// Resolving [[wikilink]] targets to files on disk.
//
// The target comes out of a document, and a document is untrusted input, so it
// is treated as a NAME and never as a path: separators are stripped before
// anything touches the filesystem, which is why "[[../../../../etc/passwd]]"
// cannot escape. Lookup is a basename match inside a bounded root, so the worst
// a hostile note can do is fail to find a file.
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface GlyphVault : NSObject

// The folder a note belongs to: the nearest ancestor holding a vault marker
// (.obsidian or .git), else the note's own folder. Bounded so a note in / does
// not turn into a search of the whole disk.
+ (nullable NSURL *)rootForNoteAtURL:(NSURL *)noteURL;

// The markdown file a wikilink target names, or nil. `target` is the raw text
// between the brackets — alias, heading anchor and any path parts are discarded.
+ (nullable NSURL *)resolveTarget:(NSString *)target fromNoteAtURL:(NSURL *)noteURL;

// Exposed for testing: what a target reduces to before the filesystem is touched.
+ (nullable NSString *)basenameForTarget:(NSString *)target;

@end

NS_ASSUME_NONNULL_END
