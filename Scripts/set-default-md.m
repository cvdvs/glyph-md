// Makes Glyph the default app for markdown files (user-level preference,
// same thing as Finder's Get Info → "Change All…").
//
//   clang -fobjc-arc Scripts/set-default-md.m -o /tmp/glyph-default -framework Cocoa -framework UniformTypeIdentifiers
//   /tmp/glyph-default            # markdown only
//   /tmp/glyph-default --with-txt # markdown AND plain text (.txt)
//
// --with-txt claims public.plain-text, which is what .txt and .text map to.
// Checked on this machine: .csv, .json and source files carry their OWN types
// (public.comma-separated-values-text, public.json, public.python-script) and
// are NOT affected — so this takes over .txt and files with no more specific
// type, and nothing else. Undo it in Finder: Get Info → Open with → Change All.
#import <Cocoa/Cocoa.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

int main(int argc, const char **argv) {
    @autoreleasepool {
        BOOL withTxt = NO;
        for (int i = 1; i < argc; i++) {
            if (strcmp(argv[i], "--with-txt") == 0) withTxt = YES;
        }
        NSURL *app = [NSURL fileURLWithPath:@"/Applications/Glyph.app"];
        if (![NSFileManager.defaultManager fileExistsAtPath:app.path]) {
            fprintf(stderr, "Glyph.app not found in /Applications\n");
            return 1;
        }

        NSMutableDictionary<NSString *, UTType *> *types = [NSMutableDictionary dictionary];
        UTType *byId = [UTType typeWithIdentifier:@"net.daringfireball.markdown"];
        if (byId) types[byId.identifier] = byId;
        for (NSString *ext in @[@"md", @"markdown", @"mdown", @"mkd"]) {
            UTType *t = [UTType typeWithFilenameExtension:ext];
            if (t && !types[t.identifier]) types[t.identifier] = t;
        }
        if (withTxt) {
            // Glyph opens these LITERALLY — no markdown formatting, saved exactly
            // as typed — so taking over .txt cannot reformat anything.
            UTType *plain = [UTType typeWithIdentifier:@"public.plain-text"];
            if (plain) types[plain.identifier] = plain;
        }
        if (types.count == 0) {
            fprintf(stderr, "no markdown type registered on this system\n");
            return 1;
        }

        __block NSInteger remaining = (NSInteger)types.count;
        for (UTType *t in types.allValues) {
            [[NSWorkspace sharedWorkspace] setDefaultApplicationAtURL:app
                                                    toOpenContentType:t
                                                    completionHandler:^(NSError *error) {
                if (error) {
                    fprintf(stderr, "FAILED %s: %s\n", t.identifier.UTF8String,
                            error.localizedDescription.UTF8String);
                } else {
                    printf("set %s -> Glyph\n", t.identifier.UTF8String);
                }
                remaining--;
            }];
        }
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:10];
        while (remaining > 0 && [deadline timeIntervalSinceNow] > 0) {
            [[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode
                                  beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.05]];
        }

        // Report what a real file of each kind now opens with, rather than
        // trusting that the calls above took effect.
        NSArray *probes = withTxt ? @[@"glyph-probe.md", @"glyph-probe.txt"]
                                  : @[@"glyph-probe.md"];
        for (NSString *name in probes) {
            NSString *probePath = [NSTemporaryDirectory() stringByAppendingPathComponent:name];
            [@"probe\n" writeToFile:probePath atomically:YES encoding:NSUTF8StringEncoding error:NULL];
            NSURL *handler = [[NSWorkspace sharedWorkspace]
                URLForApplicationToOpenURL:[NSURL fileURLWithPath:probePath]];
            printf("default app for .%s now: %s\n",
                   name.pathExtension.UTF8String, handler.path.UTF8String ?: "unknown");
            [[NSFileManager defaultManager] removeItemAtPath:probePath error:NULL];
        }
    }
    return 0;
}
