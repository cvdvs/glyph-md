// Makes Glyph the default app for markdown files (user-level preference,
// same thing as Finder's Get Info → "Change All…").
//
//   clang -fobjc-arc Scripts/set-default-md.m -o /tmp/glyph-default -framework Cocoa -framework UniformTypeIdentifiers
//   /tmp/glyph-default            # markdown only
//   /tmp/glyph-default --with-txt # markdown AND plain text (.txt)
//
// --with-txt asks for public.plain-text, which is what .txt and .text map to.
// Checked on this machine: .csv, .json and source files carry their OWN types
// (public.comma-separated-values-text, public.json, public.python-script) and
// are NOT affected.
//
// Markdown works. .txt does NOT, on macOS 26: the system no longer lets an app
// make itself the default for a built-in type like public.plain-text. The modern
// setDefaultApplicationAtURL never calls its completion handler, and the older
// LSSetDefaultRoleHandlerForContentType returns noErr and changes nothing —
// measured on 26.5.2 with Glyph correctly registered (lsregister shows
// "claimed UTIs: public.plain-text, rank: Default"). That choice now belongs to
// the user in Finder, so this script checks the real handler afterwards and
// prints the steps rather than claiming a success it did not achieve.
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
            BOOL isGlyph = [handler.path isEqualToString:app.path];
            printf("default app for .%s now: %s%s\n",
                   name.pathExtension.UTF8String, handler.path.UTF8String ?: "unknown",
                   isGlyph ? "" : "   <-- not Glyph");
            [[NSFileManager defaultManager] removeItemAtPath:probePath error:NULL];

            // macOS 26 stopped letting an app make ITSELF the default for a
            // system type like public.plain-text: both the modern
            // setDefaultApplicationAtURL (its completion handler never fires)
            // and the older LSSetDefaultRoleHandlerForContentType (returns
            // noErr and changes nothing) are ignored. Only the user can do it,
            // in Finder. Say so plainly instead of reporting success.
            if (!isGlyph && [name.pathExtension isEqualToString:@"txt"]) {
                printf("\n"
                  "  macOS will not let an app set itself as the default for .txt —\n"
                  "  that choice is yours to make, in Finder:\n"
                  "\n"
                  "    1. Right-click any .txt file -> Get Info\n"
                  "    2. Under \"Open with\", choose Glyph\n"
                  "    3. Click \"Change All…\" and confirm\n"
                  "\n"
                  "  Glyph is already registered for .txt, so it appears in that\n"
                  "  list and in right-click -> Open With straight away.\n\n");
            }
        }
    }
    return 0;
}
