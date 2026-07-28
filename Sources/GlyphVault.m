#import "GlyphVault.h"

// A vault can hold tens of thousands of files; these keep a lookup bounded even
// if a wikilink is clicked in a folder nobody expected.
static const NSUInteger kMaxFilesScanned = 40000;
static const NSUInteger kMaxAncestorsSearched = 6;

@implementation GlyphVault

+ (nullable NSString *)basenameForTarget:(NSString *)target {
    if (![target isKindOfClass:[NSString class]]) return nil;
    NSString *t = target;

    // "[[note|alias]]" and "[[note#heading]]" — only the note part names a file.
    NSRange pipe = [t rangeOfString:@"|"];
    if (pipe.location != NSNotFound) t = [t substringToIndex:pipe.location];
    NSRange hash = [t rangeOfString:@"#"];
    if (hash.location != NSNotFound) t = [t substringToIndex:hash.location];
    NSRange caret = [t rangeOfString:@"^"];
    if (caret.location != NSNotFound) t = [t substringToIndex:caret.location];

    // THE load-bearing line: a target is a name, never a path. Everything up to
    // and including the last separator is discarded, so "../../etc/passwd"
    // becomes "passwd" and can only ever match a file inside the vault.
    for (NSString *sep in @[@"/", @"\\", @":"]) {
        NSRange r = [t rangeOfString:sep options:NSBackwardsSearch];
        if (r.location != NSNotFound) t = [t substringFromIndex:NSMaxRange(r)];
    }

    t = [t stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet];
    if ([t hasSuffix:@".md"] || [t hasSuffix:@".markdown"]) {
        t = t.stringByDeletingPathExtension;
    }
    // "." and ".." reduce to nothing usable.
    if (t.length == 0 || [t isEqualToString:@"."] || [t isEqualToString:@".."]) return nil;
    if ([t rangeOfString:@"\0"].location != NSNotFound) return nil;
    return t;
}

+ (nullable NSURL *)rootForNoteAtURL:(NSURL *)noteURL {
    if (!noteURL.isFileURL) return nil;
    NSFileManager *fm = NSFileManager.defaultManager;
    NSURL *dir = noteURL.URLByDeletingLastPathComponent.URLByStandardizingPath;
    if (!dir) return nil;

    NSURL *candidate = dir;
    for (NSUInteger i = 0; i < kMaxAncestorsSearched; i++) {
        for (NSString *marker in @[@".obsidian", @".git"]) {
            if ([fm fileExistsAtPath:[candidate URLByAppendingPathComponent:marker].path]) {
                return candidate;
            }
        }
        NSURL *parent = candidate.URLByDeletingLastPathComponent.URLByStandardizingPath;
        if (!parent || [parent isEqual:candidate] || parent.path.length <= 1) break;
        candidate = parent;
    }
    return dir;
}

+ (nullable NSURL *)resolveTarget:(NSString *)target fromNoteAtURL:(NSURL *)noteURL {
    NSString *name = [self basenameForTarget:target];
    if (!name || !noteURL.isFileURL) return nil;

    NSURL *root = [self rootForNoteAtURL:noteURL];
    if (!root) return nil;
    NSFileManager *fm = NSFileManager.defaultManager;

    // The common case: a sibling of the note.
    NSURL *dir = noteURL.URLByDeletingLastPathComponent;
    for (NSString *ext in @[@"md", @"markdown", @"mdown", @"mkd"]) {
        NSURL *direct = [[dir URLByAppendingPathComponent:name] URLByAppendingPathExtension:ext];
        BOOL isDir = NO;
        if ([fm fileExistsAtPath:direct.path isDirectory:&isDir] && !isDir) {
            return direct.URLByStandardizingPath;
        }
    }

    // Otherwise search the vault by basename. Case-insensitive, because that is
    // how people write links; first match wins, shallowest first.
    NSDirectoryEnumerator *walker =
        [fm enumeratorAtURL:root
 includingPropertiesForKeys:@[NSURLIsDirectoryKey, NSURLNameKey]
                    options:NSDirectoryEnumerationSkipsHiddenFiles |
                            NSDirectoryEnumerationSkipsPackageDescendants
               errorHandler:^BOOL(NSURL *url, NSError *error) { return YES; }];
    NSUInteger scanned = 0;
    NSURL *best = nil;
    NSUInteger bestDepth = NSUIntegerMax;
    NSUInteger rootDepth = root.pathComponents.count;

    for (NSURL *url in walker) {
        if (++scanned > kMaxFilesScanned) break;
        NSNumber *isDir = nil;
        [url getResourceValue:&isDir forKey:NSURLIsDirectoryKey error:NULL];
        if (isDir.boolValue) {
            if ([url.lastPathComponent isEqualToString:@"node_modules"]) [walker skipDescendants];
            continue;
        }
        NSString *ext = url.pathExtension.lowercaseString;
        if (!([ext isEqualToString:@"md"] || [ext isEqualToString:@"markdown"] ||
              [ext isEqualToString:@"mdown"] || [ext isEqualToString:@"mkd"])) continue;
        if ([url.lastPathComponent.stringByDeletingPathExtension
                caseInsensitiveCompare:name] != NSOrderedSame) continue;
        NSUInteger depth = url.pathComponents.count - rootDepth;
        if (depth < bestDepth) { bestDepth = depth; best = url; }
    }
    return best.URLByStandardizingPath;
}

@end
