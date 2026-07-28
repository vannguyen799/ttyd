#ifndef TTYD_CLIPBOARD_H
#define TTYD_CLIPBOARD_H

#include <stdbool.h>
#include <stddef.h>
#include <uv.h>

// Loads an image into the host clipboard by piping it to xclip, so a Ctrl+V
// sent to the PTY afterwards is picked up as a real paste by whatever TUI is
// in the foreground. Used by the /clipboard-image endpoint.

typedef struct clipboard_req clipboard_req;

// status is 0 on success, otherwise a libuv error code (or 1 when xclip
// itself failed); error is a human readable message valid for the duration of
// the call only.
typedef void (*clipboard_done_cb)(void *ctx, int status, const char *error);

// Pipe `data` (`len` bytes of PNG) into the clipboard of the X display named
// by $TTYD_CLIP_DISPLAY, falling back to the inherited $DISPLAY.
//
// Takes ownership of `data` in every case. On success returns a handle and
// calls `cb` later; on failure returns NULL, stores a libuv error in `err`
// and never calls `cb`.
clipboard_req *clipboard_set_image(uv_loop_t *loop, char *data, size_t len, clipboard_done_cb cb, void *ctx, int *err);

// Give up on the reply — the caller (an HTTP connection) is going away. The
// request keeps running to completion and frees itself; `cb` is not called.
void clipboard_detach(clipboard_req *req);

#endif  // TTYD_CLIPBOARD_H
