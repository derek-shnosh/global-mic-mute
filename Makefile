UUID := global-mic-mute@derek-shnosh.github.com
EXT_DIR := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: schemas install uninstall pack clean

schemas:
	glib-compile-schemas schemas/

# Development install: symlink the working tree into the extensions dir.
install: schemas
	mkdir -p $(dir $(EXT_DIR))
	ln -sfn $(CURDIR) $(EXT_DIR)
	@echo "Linked $(EXT_DIR). Log out and back in, then: gnome-extensions enable $(UUID)"

uninstall:
	rm -f $(EXT_DIR)

# Zip for extensions.gnome.org upload.
pack:
	gnome-extensions pack --force --extra-source=LICENSE .

clean:
	rm -f schemas/gschemas.compiled *.shell-extension.zip
