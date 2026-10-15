desktop_file = configure_file(
  input: app_id + '.desktop.in',
  output: app_id + '.desktop',
  copy: true,
  install_dir: datadir / 'applications',
)

metainfo_file = configure_file(
  input: app_id + '.metainfo.xml.in',
  output: app_id + '.metainfo.xml',
  copy: true,
  install_dir: datadir / 'metainfo',
)

install_data(app_id + '.gschema.xml', install_dir: datadir / 'glib-2.0' / 'schemas')
install_data('icons' / app_id + '.svg', install_dir: datadir / 'icons' / 'hicolor' / 'scalable' / 'apps')
install_data('icons' / app_id + '-symbolic.svg', install_dir: datadir / 'icons' / 'hicolor' / 'symbolic' / 'apps')

desktop_validate = find_program('desktop-file-validate', required: false)
if desktop_validate.found()
  test('desktop', desktop_validate, args: [desktop_file])
endif

appstreamcli = find_program('appstreamcli', required: false)
if appstreamcli.found()
  test('metainfo', appstreamcli, args: ['validate', '--no-net', '--explain', metainfo_file])
endif

compile_schemas = find_program('glib-compile-schemas', required: false)
if compile_schemas.found()
  test('gschema', compile_schemas, args: ['--strict', '--dry-run', meson.current_source_dir()])
endif
