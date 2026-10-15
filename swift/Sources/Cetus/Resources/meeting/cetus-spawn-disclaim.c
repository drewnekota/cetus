// Disclaim TCC "responsibility" for a spawned child so the child becomes its
// OWN responsible process. This lets a privacy-sensitive helper (Microphone /
// Speech Recognition) use the usage-description strings in its own embedded
// Info.plist instead of inheriting the parent's identity.
//
// Why this exists: when the app spawns the speech helper directly, macOS TCC
// attributes the request to the *responsible* process — which, under `tauri
// dev`, is the bare `target/debug/cetus` binary with no Info.plist. Requesting
// Speech access then crashes the helper with SIGABRT ("must contain an
// NSSpeechRecognitionUsageDescription key"). Spawning the helper *disclaimed*
// makes it its own responsible process so its embedded plist is read, and keeps
// the identity consistent across permcheck / request / listen.
//
// Usage: cetus-spawn-disclaim <program> [args...]
// stdio (fd 0/1/2) is inherited, so the caller's pipes flow straight through to
// the child. We become our own process-group leader and the child inherits that
// group, so the caller can reap both of us by killing the group. macOS only.

#include <spawn.h>
#include <unistd.h>
#include <stdio.h>
#include <signal.h>
#include <sys/wait.h>

extern char **environ;

// Private SPI (no public header). Present on every supported macOS version.
extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim);

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: cetus-spawn-disclaim <program> [args...]\n");
        return 2;
    }

    // Become our own process-group leader so the parent can SIGKILL the whole
    // group (this shim + the disclaimed child) in one call.
    setpgid(0, 0);

    posix_spawnattr_t attr;
    posix_spawnattr_init(&attr);
    responsibility_spawnattrs_setdisclaim(&attr, 1);

    pid_t pid;
    int rc = posix_spawn(&pid, argv[1], NULL, &attr, &argv[1], environ);
    posix_spawnattr_destroy(&attr);
    if (rc != 0) {
        fprintf(stderr, "posix_spawn failed: %d\n", rc);
        return 127;
    }

    int status = 0;
    while (waitpid(pid, &status, 0) < 0) {
        // Retry on EINTR; any other error means the child is already gone.
    }
    if (WIFEXITED(status)) return WEXITSTATUS(status);
    if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
    return 0;
}
