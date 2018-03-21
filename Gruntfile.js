const path = require('path')

const debugRules = {
  logClasses: false,
  logConstructors: false,
  logDepsAsFound: false,
  logDepsAtEnd: false,
  logExtensions: false,
  logParentConstructors: false,
}

const indent = '  '

// Track dependencies for validating transpilation output
const dependencies = {
  internal: {},
  track(file, dependency) {
    if (debugRules.logDepsAsFound) {
      console.log('depends on', dependency)
    }

    const deps = dependencies.internal

    if (!deps[file]) {
      deps[file] = []
    }
    if (!deps[file].includes(dependency)) {
      deps[file].push(dependency)
    }
  },
  toString() {
    return JSON.stringify(dependencies.internal, null, 2)
  },
}

// Track inheritance for class generation
const inheritance = {
  index: {},
  isClass(prop) {
    return inheritance.index[prop] !== undefined
  },
  getParent(child) {
    return inheritance.index[child]
  },
  track(child, parent) {
    if (parent && !inheritance.index[child]) {
      if (debugRules.logExtensions) {
        console.log(child, 'extends', parent)
      }
      inheritance.index[child] = parent
    } else {
      if (!inheritance.isClass(child)) {
        if (debugRules.logClasses) {
          console.log(child, 'is a class')
        }
        inheritance.index[child] = null
      }
    }
  },
  toString() {
    return JSON.stringify(inheritance.index, null, 2)
  },
}

const getFileClass = (filepath) => path.basename(filepath, '.js')
const isFileClass = (filepath, className) => getFileClass(filepath) === className

const transpile = {
  // Replace initial ROS3D assignment
  initialROS3DAssignment: [
    // from
    /var ROS3D = ROS3D \|\| \{\n  REVISION \: '0.18.0'\n\};/m,
    // to
    `export const REVISION = '0.18.0';`,
  ],
  // Replace mutations with exported properties
  exportedProperites: [
    // from:
    // ROS3D.MARKER_ARROW = 0;
    /\nROS3D\./g,
    // to:
    // export const MARKER_ARROW = 0;
    '\nexport const ',
  ],
  // Remove ROS3D prefix on internal dependencies
  internalDependencies: (filepath) => [
    // from:
    // return ROS3D.findClosestPoint(axisRay, mpRay);
    /ROS3D\.(\w+)(?!.*=.*)/g,
    // to:
    // return findClosestPoint(axisRay, mpRay);
    (match, $1) => {
      // track dependency on $1
      dependencies.track(filepath, $1)
      return $1
    }
  ],
  // Replace __proto__ mutation with class extension
  buildInheritanceIndexViaProto: [
    // from:
    // ROS3D.PoseWithCovariance.prototype.__proto__ = THREE.Object3D.prototype;
    /ROS3D.(\w+).prototype.__proto__ = (.*).prototype;[\r\n]?/g,
    // to:
    // set PoseWithCovariance to subclass from THREE.Object3D in inheritance index
    (match, $1, $2) => {
      // track $1 extends $2
      inheritance.track($1, $2)
      // remove it
      return ''
    }
  ],
  // Replace __proto__ mutation with class extension
  buildInheritanceIndexViaObjectAssign: [
    // from:
    // Object.assign(InteractiveMarker.prototype, THREE.EventDispatcher.prototype);
    /Object.assign\((\w+).prototype, (.*).prototype\);/g,
    // to:
    // set InteractiveMarker to subclass from THREE.EventDispatcher in inheritance index
    (match, $1, $2) => {
      // track $1 extends $2
      inheritance.track($1, $2)
      // remove it
      return ''
    }
  ],
  // Refactor methods
  methods: [
    // from:
    // ROS3D.Arrow2.prototype.dispose = function() { ... };
    /ROS3D.(\w+).prototype.(\w+) = function/g,
    // to:
    // dispose() { ... };
    (match, $1, $2) => {
      // bail, not our responsibility
      if ($2 === '__proto__') {
        return match
      }
      // check for __proto__
      // track $1 is a class
      inheritance.track($1, null)
      // remove it
      return $2
    }
  ],
  // Refactor constructor functions
  constructors: (filepath) => [
    // from:
    // ROS3D.Arrow2 = function(options) { ... };
    /ROS3D.(\w+)\s*=\s*function/g,
    // to:
    // constructor(options) { ... };
    (match, $1) => {
      const isClass1 = inheritance.isClass($1)
      const isClass2 = isFileClass(filepath, $1)
      if (isClass1 !== isClass2) {
        console.log('CLASS MISMATCH')
        console.log(JSON.stringify({
          filepath,
          $1,
          isClass1,
          isClass2,
        }, null, 2))
      }
      if (inheritance.isClass($1)) {
        if (debugRules.logConstructors) {
          console.log('found constructor', { match, $1 })
        }
        return 'constructor'
      } else {
        return match
      }
    }
  ],
  // Refactor parent constructor calls
  parentConstructors: (filepath) => [
    // from:
    // constructor(options) {
    //   ...
    //   THREE.ArrowHelper.call(this, direction, origin, length, 0xff0000);
    //   ...
    // };
    /[\r\n]([\s]*)([\w.]+)\.call\((?:this|that)(.*)/g,
    // to:
    // constructor(options) {
    //   ...
    //   super(direction, origin, length, 0xff0000);
    //   ...
    // }
    (match, indent, $1, $2) => {
      const child = getFileClass(filepath)
      const parent = inheritance.getParent(child)
      if ($1 === parent) {
        // we got a super constructor call
        const args = $2
          .split(/,|\)/)  // split args from leading comma and ending paren
          .slice(1, -1)   // slice out just the args
          .join(',')      // put them back into a string
          .trim()         // trim whitespace

        if (debugRules.logParentConstructors) {
          console.log('found parent constructor', { match, child, parent, args })
        }

        return `\n${indent}super(${args});`
      } else {
        console.log('removing extra parent constructor call', { match })
        return ''
      }
    }
  ],
  // Generate class wrappers using inheritance index
  classes: (filepath, state = { isInClass: false, matchedFirstComment: false }) => [
    // from:
    // constructor(options) {
    //   ...
    // }
    //
    // dispose() {
    //   ...
    // }
    // /.*(\*\/).*|[\r\n]+$(?:[\r\n]+$)+((?![\r\n]+))|.*/gm,
    // /(\/\*\*(?:$|[.\r\n])*\*\/(?:$|[\s\r\n])*constructor\(.*)|[\r\n]+$(?:[\r\n]+$)+((?![\r\n]+))|.*/gm,
    /((?:\/\*\*(?:(?:\*[^/]|[^*])+?)\*\/)(?:[\s\r\n])*constructor\(.*)|$(?:[\r\n]$)*((?![\r\n]))|.*/gm,
    // to:
    // export class Arrow2 extends THREE.ArrowHelper {
    //   constructor(options) {
    //     ...
    //   }
    //
    //   dispose() {
    //     ...
    //   }
    // }
    (match, $1, $2) => {
      // $1 matches '/**' + anything not '*/' + '*/' + 'constructor('- aka a block comment followed by a constructor
      // $2 matches the end of a line that isn't followed by a newline char - aka EOF
      const isStart = $1 !== undefined && !state.matchedFirstComment
      const isFinish = $2 !== undefined
      const className = getFileClass(filepath)
      const parent = inheritance.getParent(className)

      if (isStart) {
        const indentedMatch = indent + match.replace(/[\r\n]/g, `\n${indent}`)
        state.matchedFirstComment = true
        state.isInClass = true
        if (parent) {
          return `export class ${className} extends ${parent} {\n\n${indentedMatch}`
        } else {
          return `export class ${className} {\n\n${indentedMatch}`
        }
      }
      if (state.isInClass) {
        if (!isFinish) {
          return `${indent}${match}`
        } else {
          state.isInClass = false
          return `\n}\n`
        }
      }

      return match
    }
  ],
  //
  //
  // Refactor superclass method calls
  //
  // pre:
  // ROS3D.InteractiveMarkerControl.prototype.updateMatrixWorld.call(that, force);
  //
  // post:
  // super.updateMatrixWorld(force)
  //
  //
  // THREE.ArrowHelper.call(this, direction, origin, length, 0xff0000);
  //
  // THREE.Object3D.call(this);
  // THREE.EventDispatcher.call(this);
  //
  // v v v v
  //
  // class Arrow2 extends THREE.ArrowHelper {
  //   constructor(...) {
  //     super(direction, origin, length, 0xff0000);
  //   }
  // }
  //
  // class InteractiveMarker extends THREE.Object3D {
  //   constructor(...) {
  //     super();
  //   }
  // }
  //
}

// Transpiles current src to ES6
const transpileToEs6 = function (content, filepath, grunt) {
  console.log('\nv -- Processing', filepath, '-- v')

  let transpiled = content

  // transpile content from current format to ES6
  if (filepath === 'src/Ros3D.js') {
    transpiled = transpiled
      .replace(...transpile.initialROS3DAssignment)
  }

  // give replace function access to filepath
  const transpileInternalDependencies = transpile.internalDependencies(filepath)
  const transpileConstructors = transpile.constructors(filepath)
  const transpileParentConstructors = transpile.parentConstructors(filepath)
  const transpileClasses = transpile.classes(filepath)

  return transpiled
  .replace(...transpileInternalDependencies)
  .replace(...transpile.buildInheritanceIndexViaProto)
  .replace(...transpile.buildInheritanceIndexViaObjectAssign)
  .replace(...transpile.methods)
  .replace(...transpileConstructors)
  .replace(...transpileParentConstructors)
  .replace(...transpileClasses)
  // .replace(...transpile.exportedProperites)
}

// Export Grunt config
module.exports = function(grunt) {

  grunt.initConfig({
    pkg: grunt.file.readJSON('package.json'),
    concat: {
      build: {
        src  : ['./src/*.js', './src/**/*.js'],
        dest : './build/ros3d.js'
      }
    },
    jshint: {
      options: {
        jshintrc: '.jshintrc'
      },
      files: [
        'Gruntfile.js',
        './build/ros3d.js',
        './tests/*.js'
      ]
    },
    karma: {
      build: {
        configFile: './test/karma.conf.js',
        singleRun: true,
        browsers: ['PhantomJS']
      }
    },
    uglify: {
      options: {
        report: 'min'
      },
      build: {
        src: './build/ros3d.js',
        dest: './build/ros3d.min.js'
      }
    },
    watch: {
      dev: {
        options: {
          interrupt: true
        },
        files: [
          './src/*.js',
          './src/**/*.js'
        ],
        tasks: ['concat']
      },
      build_and_watch: {
        options: {
          interrupt: true
        },
        files: [
          'Gruntfile.js',
          '.jshintrc',
          './src/*.js',
          './src/**/*.js'
        ],
        tasks: ['build']
      }
    },
    clean: {
      options: {
        force: true
      },
      doc: ['./doc']
    },
    jsdoc: {
      doc: {
        src: [
          './src/*.js',
          './src/**/*.js'
        ],
        options: {
          destination: './doc',
          configure: 'jsdoc_conf.json'
        }
      }
    },
    pipe: {
      transpile: {
        options: {
          process: transpileToEs6,
        },
        files: [{
          expand: true,
          cwd: 'src',
          src: ['*.js', 'interactivemarkers/InteractiveMarker.js', 'models/Arrow2.js'],
          dest: 'src-esm-test/',
        }]
      }
    },
    execute: {
      transpile: {
        call: (grunt, options) => {
          console.log()
          if (debugRules.logDepsAtEnd) {
            console.log('Internal dependencies')
            console.log(dependencies.toString())
          }
          console.log()
        },
      }
    }
  });

  grunt.loadNpmTasks('grunt-contrib-concat');
  grunt.loadNpmTasks('grunt-contrib-jshint');
  grunt.loadNpmTasks('grunt-contrib-watch');
  grunt.loadNpmTasks('grunt-contrib-uglify');
  grunt.loadNpmTasks('grunt-contrib-clean');
  grunt.loadNpmTasks('grunt-jsdoc');
  grunt.loadNpmTasks('grunt-karma');
  grunt.loadNpmTasks('grunt-pipe');
  grunt.loadNpmTasks('grunt-execute');

  grunt.registerTask('dev', ['concat', 'watch']);
  grunt.registerTask('build', ['concat', 'jshint', 'uglify']);
  grunt.registerTask('build_and_watch', ['watch']);
  grunt.registerTask('doc', ['clean', 'jsdoc']);
  grunt.registerTask('transpile', ['pipe', 'execute']);
};
