module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: [
    '**/*.(t|j)s',
    '!**/*.interface.ts',
    '!**/main.ts',
  ],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^@types/(.*)$': '<rootDir>/../types/$1.d.ts',
  },
  // scripts/ci: el bump de versión de GitHub Actions vive fuera de src/ (docs/reglas-desarrollo/versionado.md).
  roots: ['<rootDir>', '<rootDir>/../scripts/ci'],
  preset: 'ts-jest',
};
