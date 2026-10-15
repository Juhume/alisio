# El JavaScript lo genera esbuild (npm run build) antes de meson; aquí solo se empaqueta.
bundle_dir = meson.project_source_root() / 'build' / 'js'
if not fs.exists(bundle_dir / 'main.js')
  error('Falta build/js/main.js: ejecuta «npm run build» antes de compilar con meson.')
endif

gnome.compile_resources(app_id + '.src',
  app_id + '.src.gresource.xml',
  source_dir: [bundle_dir, 'ui'],
  gresource_bundle: true,
  install: true,
  install_dir: pkgdatadir,
)

launcher = configuration_data()
launcher.set('GJS', find_program('gjs').full_path())
launcher.set('APP_ID', app_id)
launcher.set('VERSION', meson.project_version())
launcher.set('PKGDATADIR', pkgdatadir)
launcher.set('LOCALEDIR', localedir)

configure_file(
  input: app_id + '.in',
  output: app_id,
  configuration: launcher,
  install: true,
  install_dir: get_option('bindir'),
  install_mode: 'rwxr-xr-x',
)
