// The "Glyph Server" app's main executable.
//
// It exists for one reason: macOS attaches a Full Disk Access grant to a SIGNED
// PROGRAM, and a shell script is not one. When launchd runs a script, the kernel
// execs /bin/zsh with the script as input, so the process TCC sees is /bin/zsh —
// a system tool that has no grant and cannot be given one sensibly. Measured:
// with the app's executable as a zsh script, the grant had no effect at all and
// the job still could not read ~/Documents.
//
// A compiled binary gives the bundle a real Mach-O to sign, so the grant has
// something to attach to. It is deliberately tiny and frozen: the grant follows
// this binary's signature, so rewriting it would cost the permission. All it
// does is hand off to the launcher, which lives in the repo and can change
// freely.
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char **argv) {
    const char *launcher = getenv("GLYPH_LAUNCHER");
    if (!launcher || !*launcher) {
        fprintf(stderr, "glyph-server: GLYPH_LAUNCHER is not set.\n"
                        "The launch agent should provide it.\n");
        return 78;  // EX_CONFIG
    }
    // argv[0] becomes the launcher; the rest (the folder to serve) passes through.
    argv[0] = (char *)launcher;
    execv(launcher, argv);
    // Only reached if exec failed — say why rather than dying silently.
    perror("glyph-server: cannot run the launcher");
    fprintf(stderr, "  tried: %s\n", launcher);
    return 78;
}
