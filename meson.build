project('alisio',
  version: '0.1.0',
  license: 'GPL-3.0-or-later',
  meson_version: '>= 1.0.0',
)

app_id = 'io.github.juhume.Alisio'
gnome = import('gnome')
fs = import('fs')

prefix = get_option('prefix')
datadir = prefix / get_option('datadir')
pkgdatadir = datadir / app_id
localedir = prefix / get_option('localedir')

subdir('data')
subdir('src')

gnome.post_install(
  glib_compile_schemas: true,
  gtk_update_icon_cache: true,
  update_desktop_database: true,
)
