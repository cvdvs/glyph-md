// Wikilink resolution, including the cases a hostile note would try.
//
//   clang -fobjc-arc Scripts/vault-smoke.m Sources/GlyphVault.m -o /tmp/vault-smoke -framework Foundation
//   /tmp/vault-smoke <a writable temp dir>
//
// A wikilink target is text from a document, so the load-bearing property is
// that it names a file and can never describe a path out of the vault.
#import <Foundation/Foundation.h>
#import "../Sources/GlyphVault.h"

static int fails = 0;

static void Expect(const char *what, BOOL cond) {
    if (!cond) { printf("  FAIL  %s\n", what); fails++; }
    else printf("  ok    %s\n", what);
}

static void ExpectName(const char *what, NSString *target, NSString *want) {
    NSString *got = [GlyphVault basenameForTarget:target];
    BOOL ok = want ? [got isEqualToString:want] : (got == nil);
    if (!ok) {
        printf("  FAIL  %-52s got %s want %s\n", what,
               got.UTF8String ?: "(nil)", want.UTF8String ?: "(nil)");
        fails++;
    } else printf("  ok    %-52s %s\n", what, got.UTF8String ?: "(nil)");
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSString *base = @(argv[1]);
        NSFileManager *fm = NSFileManager.defaultManager;
        NSString *vault = [base stringByAppendingPathComponent:@"vault"];
        NSString *sub = [vault stringByAppendingPathComponent:@"notes/deep"];
        [fm createDirectoryAtPath:sub withIntermediateDirectories:YES attributes:nil error:NULL];
        [fm createDirectoryAtPath:[vault stringByAppendingPathComponent:@".obsidian"]
      withIntermediateDirectories:YES attributes:nil error:NULL];

        NSString *note = [vault stringByAppendingPathComponent:@"index.md"];
        [@"# index" writeToFile:note atomically:YES encoding:NSUTF8StringEncoding error:NULL];
        [@"# sibling" writeToFile:[vault stringByAppendingPathComponent:@"sibling.md"]
                       atomically:YES encoding:NSUTF8StringEncoding error:NULL];
        [@"# buried" writeToFile:[sub stringByAppendingPathComponent:@"Buried Note.md"]
                      atomically:YES encoding:NSUTF8StringEncoding error:NULL];
        // A file OUTSIDE the vault that a traversal would be aiming for.
        [@"secret" writeToFile:[base stringByAppendingPathComponent:@"passwd.md"]
                    atomically:YES encoding:NSUTF8StringEncoding error:NULL];
        NSURL *noteURL = [NSURL fileURLWithPath:note];

        printf("target -> name\n");
        ExpectName("plain", @"sibling", @"sibling");
        ExpectName("alias is not part of the name", @"sibling|Some Alias", @"sibling");
        ExpectName("heading anchor dropped", @"sibling#A Heading", @"sibling");
        ExpectName("block anchor dropped", @"sibling^blockid", @"sibling");
        ExpectName("extension dropped", @"sibling.md", @"sibling");
        ExpectName("folder path reduced to the name", @"notes/deep/Buried Note", @"Buried Note");
        ExpectName("parent traversal reduced to the name", @"../../../../etc/passwd", @"passwd");
        ExpectName("windows separators too", @"..\\..\\windows\\system32", @"system32");
        ExpectName("absolute path reduced", @"/etc/passwd", @"passwd");
        ExpectName("dot", @".", nil);
        ExpectName("dot dot", @"..", nil);
        ExpectName("empty", @"", nil);
        ExpectName("whitespace only", @"   ", nil);

        printf("\nname -> file\n");
        NSURL *sibling = [GlyphVault resolveTarget:@"sibling" fromNoteAtURL:noteURL];
        Expect("a sibling note resolves", [sibling.lastPathComponent isEqualToString:@"sibling.md"]);

        NSURL *buried = [GlyphVault resolveTarget:@"Buried Note" fromNoteAtURL:noteURL];
        Expect("a note deeper in the vault resolves",
               [buried.lastPathComponent isEqualToString:@"Buried Note.md"]);

        NSURL *cased = [GlyphVault resolveTarget:@"buried note" fromNoteAtURL:noteURL];
        Expect("resolution is case-insensitive", cased != nil);

        NSURL *aliased = [GlyphVault resolveTarget:@"sibling|Display Text" fromNoteAtURL:noteURL];
        Expect("an aliased link resolves to the target",
               [aliased.lastPathComponent isEqualToString:@"sibling.md"]);

        // The whole point: a traversal must not reach the file outside the vault.
        NSURL *escaped = [GlyphVault resolveTarget:@"../../../../etc/passwd" fromNoteAtURL:noteURL];
        Expect("traversal cannot escape the vault", escaped == nil);

        NSURL *outside = [GlyphVault resolveTarget:@"../passwd" fromNoteAtURL:noteURL];
        Expect("a sibling of the vault is not reachable", outside == nil);

        NSURL *absolute = [GlyphVault resolveTarget:@"/etc/hosts" fromNoteAtURL:noteURL];
        Expect("an absolute path is not reachable", absolute == nil);

        NSURL *missing = [GlyphVault resolveTarget:@"no such note" fromNoteAtURL:noteURL];
        Expect("a missing note resolves to nothing", missing == nil);

        printf("\nvault root\n");
        NSURL *root = [GlyphVault rootForNoteAtURL:
                       [NSURL fileURLWithPath:[sub stringByAppendingPathComponent:@"Buried Note.md"]]];
        // Standardize both sides: /tmp is a symlink to /private/tmp, and the
        // resolver standardizes while the literal path here does not.
        Expect("the .obsidian marker defines the root",
               [root.path isEqualToString:
                [NSURL fileURLWithPath:vault].URLByStandardizingPath.path]);

        printf("\n%s\n", fails ? "FAILURES" : "all pass");
        return fails ? 1 : 0;
    }
}
