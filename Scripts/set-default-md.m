// Makes Glyph the default app for markdown files (user-level preference,
// same thing as Finder's Get Info → "Change All…").
// Build and run:
//   clang -fobjc-arc Scripts/set-default-md.m -o /tmp/glyph-default -framework Cocoa -framework UniformTypeIdentifiers
//   /tmp/glyph-default
#import <Cocoa/Cocoa.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

int main(void) {
    @autoreleasepool {
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

        NSString *probePath = [NSTemporaryDirectory() stringByAppendingPathComponent:@"glyph-probe.md"];
        [@"# probe\n" writeToFile:probePath atomically:YES encoding:NSUTF8StringEncoding error:NULL];
        NSURL *handler = [[NSWorkspace sharedWorkspace]
            URLForApplicationToOpenURL:[NSURL fileURLWithPath:probePath]];
        printf("default app for .md now: %s\n", handler.path.UTF8String ?: "unknown");
        [[NSFileManager defaultManager] removeItemAtPath:probePath error:NULL];
    }
    return 0;
}
