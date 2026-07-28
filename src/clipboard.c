#include "clipboard.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "utils.h"

#ifdef _WIN32
// xclip is X11 only, and there is no headless clipboard to arm on Windows.
clipboard_req *clipboard_set_image(uv_loop_t *loop, char *data, size_t len, clipboard_done_cb cb, void *ctx,
                                   int *err) {
  free(data);
  *err = UV_ENOSYS;
  return NULL;
}

void clipboard_detach(clipboard_req *req) {}
#else

#include <signal.h>

extern char **environ;

// xclip claims the X selection and only then forks into the background, so
// its parent exiting is a stronger "the clipboard is armed" signal than
// merely having written the bytes: it also surfaces failures such as a
// missing display. Should some xclip build not fork, this caps how long a
// request waits on it.
#define XCLIP_EXIT_TIMEOUT_MS 3000

struct clipboard_req {
  uv_process_t process;
  uv_pipe_t stdin_pipe;
  uv_write_t write_req;
  uv_timer_t timer;
  uv_buf_t buf;
  char *data;
  clipboard_done_cb cb;
  void *ctx;
  int handles;  // open uv handles; the request frees itself when this hits 0
  bool replied;
  char error[128];
};

static void handle_closed_cb(uv_handle_t *handle) {
  clipboard_req *req = (clipboard_req *)handle->data;
  if (--req->handles > 0) return;

  free(req->data);
  free(req);
}

static void close_handle(uv_handle_t *handle) {
  if (!uv_is_closing(handle)) uv_close(handle, handle_closed_cb);
}

static void clipboard_reply(clipboard_req *req, int status, const char *error) {
  if (req->replied) return;
  req->replied = true;

  // The timer exists only to bound the wait for the reply; retire it here so
  // every code path converges on the same teardown.
  close_handle((uv_handle_t *)&req->timer);

  if (req->cb != NULL) req->cb(req->ctx, status, error);
  req->cb = NULL;
}

// Tear down without reporting anything — used when the request never got off
// the ground, so the caller reports the error itself.
static void clipboard_abort(clipboard_req *req) {
  req->replied = true;
  req->cb = NULL;
  close_handle((uv_handle_t *)&req->stdin_pipe);
  close_handle((uv_handle_t *)&req->timer);
}

static void timeout_cb(uv_timer_t *timer) {
  clipboard_req *req = (clipboard_req *)timer->data;
  // The bytes are in xclip's hands; a slow exit is not an error.
  clipboard_reply(req, 0, NULL);
}

static void write_cb(uv_write_t *write_req, int status) {
  clipboard_req *req = (clipboard_req *)write_req->data;

  // Closing our end delivers the EOF that makes xclip take the selection.
  close_handle((uv_handle_t *)&req->stdin_pipe);

  if (status != 0) {
    snprintf(req->error, sizeof(req->error), "write to xclip: %s", uv_strerror(status));
    clipboard_reply(req, status, req->error);
    uv_process_kill(&req->process, SIGKILL);
    return;
  }

  if (!req->replied) uv_timer_start(&req->timer, timeout_cb, XCLIP_EXIT_TIMEOUT_MS, 0);
}

static void process_exit_cb(uv_process_t *process, int64_t exit_status, int term_signal) {
  clipboard_req *req = (clipboard_req *)process->data;

  if (exit_status != 0 || term_signal != 0) {
    snprintf(req->error, sizeof(req->error), "xclip exited with status %d, signal %d", (int)exit_status, term_signal);
    clipboard_reply(req, 1, req->error);
  } else {
    clipboard_reply(req, 0, NULL);
  }

  close_handle((uv_handle_t *)process);
}

// The clipboard lives on a headless X display started alongside ttyd, which
// is not necessarily the $DISPLAY ttyd itself inherited. Returning NULL means
// "inherit the environment unchanged".
static char **clipboard_env(void) {
  const char *display = getenv("TTYD_CLIP_DISPLAY");
  if (display == NULL || *display == '\0') return NULL;

  size_t count = 0;
  for (char **e = environ; *e != NULL; e++) count++;

  char **env = xmalloc(sizeof(char *) * (count + 2));
  size_t i = 0;
  for (char **e = environ; *e != NULL; e++) {
    if (strncmp(*e, "DISPLAY=", 8) == 0) continue;
    env[i++] = *e;
  }

  size_t len = strlen("DISPLAY=") + strlen(display) + 1;
  char *entry = xmalloc(len);
  snprintf(entry, len, "DISPLAY=%s", display);
  env[i++] = entry;
  env[i] = NULL;

  return env;
}

static void clipboard_env_free(char **env) {
  if (env == NULL) return;

  // Only the DISPLAY entry was allocated here; the rest alias environ.
  for (char **e = env; *e != NULL; e++) {
    if (strncmp(*e, "DISPLAY=", 8) == 0) free(*e);
  }
  free(env);
}

clipboard_req *clipboard_set_image(uv_loop_t *loop, char *data, size_t len, clipboard_done_cb cb, void *ctx,
                                   int *err) {
  clipboard_req *req = xmalloc(sizeof(clipboard_req));
  memset(req, 0, sizeof(clipboard_req));
  req->data = data;
  req->cb = cb;
  req->ctx = ctx;
  req->write_req.data = req;

  // Both handles are set up before the spawn so that every failure path below
  // can hand cleanup to the same refcounted teardown.
  uv_pipe_init(loop, &req->stdin_pipe, 0);
  req->stdin_pipe.data = req;
  req->handles++;
  uv_timer_init(loop, &req->timer);
  req->timer.data = req;
  req->handles++;

  char *argv[] = {"xclip", "-selection", "clipboard", "-t", "image/png", "-i", NULL};
  uv_stdio_container_t stdio[3];
  stdio[0].flags = UV_CREATE_PIPE | UV_READABLE_PIPE;
  stdio[0].data.stream = (uv_stream_t *)&req->stdin_pipe;
  stdio[1].flags = UV_IGNORE;
  stdio[2].flags = UV_IGNORE;

  uv_process_options_t options;
  memset(&options, 0, sizeof(options));
  options.file = argv[0];
  options.args = argv;
  options.env = clipboard_env();
  options.stdio = stdio;
  options.stdio_count = 3;
  options.exit_cb = process_exit_cb;

  int status = uv_spawn(loop, &req->process, &options);
  clipboard_env_free(options.env);
  if (status != 0) {
    *err = status;
    clipboard_abort(req);
    return NULL;
  }
  req->process.data = req;
  req->handles++;

  req->buf = uv_buf_init(data, (unsigned int)len);
  status = uv_write(&req->write_req, (uv_stream_t *)&req->stdin_pipe, &req->buf, 1, write_cb);
  if (status != 0) {
    *err = status;
    uv_process_kill(&req->process, SIGKILL);
    clipboard_abort(req);
    return NULL;
  }

  return req;
}

void clipboard_detach(clipboard_req *req) {
  if (req == NULL) return;
  req->cb = NULL;
  req->ctx = NULL;
}
#endif
