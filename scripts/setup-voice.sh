#!/usr/bin/env bash
# setup-voice.sh — Install whisper.cpp (CUDA) and download the large-v3 model
# Target: Ubuntu 24.04 x64 with NVIDIA GPU
#
# Usage:
#   ./scripts/setup-voice.sh          # full install (build + model)
#   ./scripts/setup-voice.sh --check  # check what's installed
#   ./scripts/setup-voice.sh --model-only  # skip build, download model only

set -euo pipefail

# ─── Configuration ──────────────────────────────────────────────────────────
WHISPER_REPO="https://github.com/ggerganov/whisper.cpp.git"
WHISPER_TAG="v1.7.5"
INSTALL_DIR="$HOME/.local"
BIN_DIR="$INSTALL_DIR/bin"
MODEL_DIR="$INSTALL_DIR/share/whisper-cpp"
MODEL_NAME="ggml-large-v3.bin"
MODEL_URL="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL_NAME"
BUILD_DIR="/tmp/whisper-cpp-build"
JOBS=$(nproc 2>/dev/null || echo 4)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail()  { echo -e "${RED}[FAIL]${NC} $*"; }

# ─── Dependency Check ───────────────────────────────────────────────────────
check_deps() {
  local missing=()

  echo ""
  echo "=== System Check ==="
  echo ""

  # GPU
  if command -v nvidia-smi &>/dev/null; then
    local gpu
    gpu=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)
    ok "GPU: $gpu"
  else
    fail "nvidia-smi not found — no NVIDIA GPU detected"
    missing+=("nvidia-driver")
  fi

  # CUDA toolkit
  if command -v nvcc &>/dev/null; then
    ok "CUDA toolkit: $(nvcc --version 2>/dev/null | grep release | sed 's/.*release //' | sed 's/,.*//')"
  else
    fail "nvcc not found — install: sudo apt install nvidia-cuda-toolkit"
    missing+=("nvidia-cuda-toolkit")
  fi

  # cuBLAS
  if [ -f /usr/include/cublas.h ] || [ -f /usr/local/cuda/include/cublas.h ]; then
    ok "cuBLAS headers found"
  else
    fail "cuBLAS headers not found — install: sudo apt install libcublas-dev"
    missing+=("libcublas-dev")
  fi

  if ldconfig -p 2>/dev/null | grep -q libcublas.so || [ -f /usr/lib/x86_64-linux-gnu/libcublas.so ] || [ -f /usr/local/cuda/lib64/libcublas.so ]; then
    ok "cuBLAS library found"
  else
    fail "cuBLAS library not found — install: sudo apt install libcublas12"
    missing+=("libcublas12")
  fi

  # Build tools
  if command -v cmake &>/dev/null; then
    ok "cmake: $(cmake --version | head -1)"
  else
    fail "cmake not found — install: sudo apt install cmake"
    missing+=("cmake")
  fi

  if command -v gcc &>/dev/null; then
    ok "gcc: $(gcc --version | head -1)"
  else
    fail "gcc not found — install: sudo apt install build-essential"
    missing+=("build-essential")
  fi

  # Audio recording
  local rec_found=false
  for tool in parec arecord sox; do
    if command -v "$tool" &>/dev/null; then
      ok "Recorder: $tool"
      rec_found=true
      break
    fi
  done
  if [ "$rec_found" = false ]; then
    fail "No audio recorder — install: sudo apt install pulseaudio-utils"
    missing+=("pulseaudio-utils")
  fi

  # whisper binaries
  echo ""
  echo "=== Whisper Status ==="
  echo ""

  local whisper_bin=""
  for name in whisper-cli whisper-cpp; do
    if command -v "$name" &>/dev/null; then
      whisper_bin=$(command -v "$name")
      break
    fi
  done
  if [ -n "$whisper_bin" ]; then
    ok "whisper-cli: $whisper_bin"
  elif [ -f "$BIN_DIR/whisper-cli" ]; then
    ok "whisper-cli: $BIN_DIR/whisper-cli (not on PATH)"
    warn "Add to PATH: export PATH=\"$BIN_DIR:\$PATH\""
  else
    warn "whisper-cli not installed"
  fi

  local stream_bin=""
  for name in whisper-stream stream; do
    if command -v "$name" &>/dev/null; then
      stream_bin=$(command -v "$name")
      break
    fi
  done
  if [ -n "$stream_bin" ]; then
    ok "stream: $stream_bin"
  elif [ -f "$BIN_DIR/whisper-stream" ]; then
    ok "stream: $BIN_DIR/whisper-stream (not on PATH)"
  else
    warn "whisper stream not installed"
  fi

  # Model
  echo ""
  echo "=== Model Status ==="
  echo ""

  local model_found=false
  for dir in "$MODEL_DIR" "$HOME/.cache/whisper" "$HOME/.whisper" "$HOME/whisper.cpp/models"; do
    if [ -f "$dir/$MODEL_NAME" ]; then
      local size
      size=$(du -sh "$dir/$MODEL_NAME" 2>/dev/null | cut -f1)
      ok "Model: $dir/$MODEL_NAME ($size)"
      model_found=true
      break
    fi
  done
  if [ "$model_found" = false ]; then
    if [ -n "${WHISPER_CPP_MODEL:-}" ] && [ -f "$WHISPER_CPP_MODEL" ]; then
      ok "Model (env): $WHISPER_CPP_MODEL"
    else
      warn "Model $MODEL_NAME not found"
    fi
  fi

  echo ""

  if [ ${#missing[@]} -gt 0 ]; then
    fail "Missing system packages: ${missing[*]}"
    echo ""
    echo "  sudo apt install ${missing[*]}"
    echo ""
    return 1
  fi

  return 0
}

# ─── Build whisper.cpp ──────────────────────────────────────────────────────
build_whisper() {
  info "Building whisper.cpp with CUDA support..."

  # Clean previous build
  rm -rf "$BUILD_DIR"
  mkdir -p "$BUILD_DIR"

  # Clone
  info "Cloning whisper.cpp ($WHISPER_TAG)..."
  git clone --depth 1 --branch "$WHISPER_TAG" "$WHISPER_REPO" "$BUILD_DIR/whisper.cpp"

  cd "$BUILD_DIR/whisper.cpp"

  # Check for SDL2 (needed for stream example / wake word)
  if ! pkg-config --exists sdl2 2>/dev/null; then
    warn "libsdl2-dev not found — installing for stream/wake word support..."
    sudo apt-get install -y libsdl2-dev 2>/dev/null || warn "Could not install libsdl2-dev — stream binary may not build"
  fi

  # Configure with CUDA
  info "Configuring with CUDA (cuBLAS)..."
  cmake -B build \
    -DGGML_CUDA=ON \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$INSTALL_DIR" \
    -DWHISPER_BUILD_EXAMPLES=ON \
    -DWHISPER_SDL2=ON

  # Build
  info "Building with $JOBS threads..."
  cmake --build build -j "$JOBS"

  # Install binaries
  mkdir -p "$BIN_DIR"

  # Main whisper CLI
  if [ -f build/bin/whisper-cli ]; then
    cp build/bin/whisper-cli "$BIN_DIR/whisper-cli"
    ok "Installed: $BIN_DIR/whisper-cli"
  elif [ -f build/bin/main ]; then
    cp build/bin/main "$BIN_DIR/whisper-cli"
    ok "Installed: $BIN_DIR/whisper-cli (from main)"
  else
    fail "whisper-cli binary not found in build output"
    # Try to find it
    find build -name "whisper-cli" -o -name "main" 2>/dev/null | head -5
    return 1
  fi

  # Stream binary — search multiple possible names
  local stream_found=false
  for candidate in build/bin/whisper-stream build/bin/stream build/examples/stream/stream; do
    if [ -f "$candidate" ]; then
      cp "$candidate" "$BIN_DIR/whisper-stream"
      ok "Installed: $BIN_DIR/whisper-stream (from $(basename $candidate))"
      stream_found=true
      break
    fi
  done
  if [ "$stream_found" = false ]; then
    # Try building explicitly
    info "Stream binary not in default build — building stream example..."
    cmake --build build --target stream 2>/dev/null || true
    for candidate in build/bin/stream build/examples/stream/stream; do
      if [ -f "$candidate" ]; then
        cp "$candidate" "$BIN_DIR/whisper-stream"
        ok "Installed: $BIN_DIR/whisper-stream"
        stream_found=true
        break
      fi
    done
    if [ "$stream_found" = false ]; then
      warn "stream binary could not be built — wake word detection won't work"
    fi
  fi

  # Install shared libraries (whisper + ggml)
  mkdir -p "$INSTALL_DIR/lib"
  for pattern in "build/src/libwhisper*" "build/ggml/src/libggml*" "build/ggml/src/ggml-cuda/libggml-cuda*" "build/ggml/src/ggml-cpu/libggml-cpu*"; do
    for lib in $pattern; do
      [ -f "$lib" ] && cp -a "$lib" "$INSTALL_DIR/lib/" 2>/dev/null || true
    done
  done
  if [ -f "$INSTALL_DIR/lib/libwhisper.so" ]; then
    ok "Installed libraries to $INSTALL_DIR/lib/"
  fi

  # Verify CUDA support
  echo ""
  info "Verifying CUDA support..."
  if "$BIN_DIR/whisper-cli" --help 2>&1 | grep -qi "gpu\|cuda"; then
    ok "CUDA/GPU support confirmed"
  else
    warn "Could not confirm CUDA support — the binary may still work with GPU"
  fi

  # Cleanup
  cd /
  rm -rf "$BUILD_DIR"
  ok "Build directory cleaned up"
}

# ─── Download Model ─────────────────────────────────────────────────────────
download_model() {
  mkdir -p "$MODEL_DIR"

  local target="$MODEL_DIR/$MODEL_NAME"

  if [ -f "$target" ]; then
    local size
    size=$(du -sh "$target" | cut -f1)
    ok "Model already exists: $target ($size)"
    return 0
  fi

  info "Downloading $MODEL_NAME (~3.1 GB)..."
  info "This may take a while depending on your connection speed."
  echo ""

  # Use wget or curl
  if command -v wget &>/dev/null; then
    wget -q --show-progress -O "$target.tmp" "$MODEL_URL"
  elif command -v curl &>/dev/null; then
    curl -L --progress-bar -o "$target.tmp" "$MODEL_URL"
  else
    fail "Neither wget nor curl found"
    return 1
  fi

  # Verify download (should be > 2GB)
  local size_bytes
  size_bytes=$(stat -c%s "$target.tmp" 2>/dev/null || echo 0)
  if [ "$size_bytes" -lt 2000000000 ]; then
    fail "Download seems incomplete ($size_bytes bytes). Expected ~3.1 GB."
    rm -f "$target.tmp"
    return 1
  fi

  mv "$target.tmp" "$target"
  local size
  size=$(du -sh "$target" | cut -f1)
  ok "Model downloaded: $target ($size)"
}

# ─── PATH Setup ─────────────────────────────────────────────────────────────
setup_path() {
  # Check if BIN_DIR is already on PATH
  if echo "$PATH" | tr ':' '\n' | grep -qx "$BIN_DIR"; then
    ok "$BIN_DIR already on PATH"
    return
  fi

  echo ""
  info "Adding $BIN_DIR to PATH..."

  local shell_rc=""
  if [ -n "${FISH_VERSION:-}" ] || [ "$(basename "${SHELL:-}")" = "fish" ]; then
    shell_rc="$HOME/.config/fish/config.fish"
    local fish_line="fish_add_path $BIN_DIR"
    if [ -f "$shell_rc" ] && grep -qF "$BIN_DIR" "$shell_rc"; then
      ok "Already in $shell_rc"
    else
      mkdir -p "$(dirname "$shell_rc")"
      echo "" >> "$shell_rc"
      echo "# whisper.cpp" >> "$shell_rc"
      echo "$fish_line" >> "$shell_rc"
      ok "Added to $shell_rc"
    fi
  elif [ -f "$HOME/.bashrc" ]; then
    shell_rc="$HOME/.bashrc"
    local bash_line="export PATH=\"$BIN_DIR:\$PATH\""
    if grep -qF "$BIN_DIR" "$shell_rc"; then
      ok "Already in $shell_rc"
    else
      echo "" >> "$shell_rc"
      echo "# whisper.cpp" >> "$shell_rc"
      echo "$bash_line" >> "$shell_rc"
      ok "Added to $shell_rc"
    fi
  elif [ -f "$HOME/.zshrc" ]; then
    shell_rc="$HOME/.zshrc"
    local zsh_line="export PATH=\"$BIN_DIR:\$PATH\""
    if grep -qF "$BIN_DIR" "$shell_rc"; then
      ok "Already in $shell_rc"
    else
      echo "" >> "$shell_rc"
      echo "# whisper.cpp" >> "$shell_rc"
      echo "$zsh_line" >> "$shell_rc"
      ok "Added to $shell_rc"
    fi
  fi

  # Export for current session
  export PATH="$BIN_DIR:$PATH"
  export LD_LIBRARY_PATH="$INSTALL_DIR/lib:${LD_LIBRARY_PATH:-}"

  # Set LD_LIBRARY_PATH in shell rc
  local lib_dir="$INSTALL_DIR/lib"
  if [ -d "$lib_dir" ] && [ -n "$shell_rc" ]; then
    if [ "$(basename "${SHELL:-}")" = "fish" ]; then
      if ! grep -qF "whisper.*LD_LIBRARY_PATH" "$shell_rc" 2>/dev/null; then
        echo "set -gx LD_LIBRARY_PATH $lib_dir \$LD_LIBRARY_PATH" >> "$shell_rc"
        ok "Set LD_LIBRARY_PATH in $shell_rc"
      fi
    else
      if ! grep -qF "$lib_dir" "$shell_rc" 2>/dev/null || ! grep -qF "LD_LIBRARY_PATH" "$shell_rc" 2>/dev/null; then
        echo "export LD_LIBRARY_PATH=\"$lib_dir:\$LD_LIBRARY_PATH\"" >> "$shell_rc"
        ok "Set LD_LIBRARY_PATH in $shell_rc"
      fi
    fi
  fi

  # Set env var for model
  local model_path="$MODEL_DIR/$MODEL_NAME"
  if [ -f "$model_path" ]; then
    export WHISPER_CPP_MODEL="$model_path"
    if [ -n "$shell_rc" ] && ! grep -qF "WHISPER_CPP_MODEL" "$shell_rc"; then
      echo "export WHISPER_CPP_MODEL=\"$model_path\"" >> "$shell_rc"
      ok "Set WHISPER_CPP_MODEL in $shell_rc"
    fi
  fi

  warn "Run 'source $shell_rc' or restart your shell to apply PATH changes"
}

# ─── Main ───────────────────────────────────────────────────────────────────
main() {
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  ClawControl Voice Setup                                    ║"
  echo "║  whisper.cpp (CUDA) + large-v3 model                       ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
  echo ""

  local mode="${1:-full}"

  case "$mode" in
    --check|-c)
      check_deps
      exit $?
      ;;
    --model-only|-m)
      download_model
      setup_path
      ;;
    --build-only|-b)
      check_deps || exit 1
      build_whisper
      setup_path
      ;;
    full|--full|-f|"")
      check_deps || exit 1
      echo ""
      build_whisper
      echo ""
      download_model
      echo ""
      setup_path
      ;;
    --help|-h)
      echo "Usage: $0 [option]"
      echo ""
      echo "Options:"
      echo "  (none), --full     Full install: build whisper.cpp + download model"
      echo "  --check, -c        Check system dependencies"
      echo "  --build-only, -b   Build whisper.cpp only (skip model download)"
      echo "  --model-only, -m   Download model only (skip build)"
      echo "  --help, -h         Show this help"
      echo ""
      echo "Environment:"
      echo "  WHISPER_TAG        Git tag to build (default: $WHISPER_TAG)"
      echo "  INSTALL_DIR        Install prefix (default: $INSTALL_DIR)"
      echo "  MODEL_NAME         Model filename (default: $MODEL_NAME)"
      echo ""
      exit 0
      ;;
    *)
      fail "Unknown option: $mode"
      echo "Run $0 --help for usage"
      exit 1
      ;;
  esac

  echo ""
  echo "=== Final Status ==="
  echo ""
  check_deps
  echo ""
  ok "Setup complete! Restart ClawControl to enable voice features."
}

main "$@"
