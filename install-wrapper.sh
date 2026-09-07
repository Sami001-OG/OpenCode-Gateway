#!/usr/bin/env sh
# Installs the `opencode setup` / `opencode gateway ...` shortcuts for bash/zsh.
# Run once:  sh install-wrapper.sh   (appends to ~/.bashrc and ~/.zshrc if present)
# Then restart your terminal. The real opencode CLI is untouched — the function
# only intercepts the words `setup` and `gateway`, everything else passes through.
snippet='# >>> opencode-gateway wrapper >>>
opencode() {
  if [ "$1" = "setup" ]; then
    shift
    # Open the TUI with the /setup wizard prompt (from this repo'"'"'s .opencode/commands)
    if [ $# -gt 0 ]; then command opencode --prompt "/setup $*"
    else command opencode --prompt "/setup"; fi
  elif [ "$1" = "gateway" ]; then
    shift; opencode-gateway "$@"
  else
    command opencode "$@"
  fi
}
# <<< opencode-gateway wrapper <<<'
for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
  [ -f "$rc" ] || continue
  if grep -q "opencode-gateway wrapper >>>" "$rc" 2>/dev/null; then
    echo "already present in $rc"
  else
    printf '\n%s\n' "$snippet" >> "$rc"
    echo "installed in $rc"
  fi
done
echo "Restart your terminal, then:  opencode setup"
