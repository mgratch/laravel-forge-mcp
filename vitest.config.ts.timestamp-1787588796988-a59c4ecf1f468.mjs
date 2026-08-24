// vitest.config.ts
import { defineConfig } from "file:///sessions/loving-lucid-hawking/mnt/outputs/laravel-forge-mcp/node_modules/vitest/dist/config.js";
var vitest_config_default = defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      // Generated code mirrors the spec and is covered by contract tests;
      // index.ts is process bootstrap (stdio + exit codes), exercised by the
      // build rather than by unit tests.
      exclude: ["src/generated/**", "src/index.ts", "src/tools/types.ts"],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 }
    }
  }
});
export {
  vitest_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZXN0LmNvbmZpZy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIi9zZXNzaW9ucy9sb3ZpbmctbHVjaWQtaGF3a2luZy9tbnQvb3V0cHV0cy9sYXJhdmVsLWZvcmdlLW1jcFwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiL3Nlc3Npb25zL2xvdmluZy1sdWNpZC1oYXdraW5nL21udC9vdXRwdXRzL2xhcmF2ZWwtZm9yZ2UtbWNwL3ZpdGVzdC5jb25maWcudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL3Nlc3Npb25zL2xvdmluZy1sdWNpZC1oYXdraW5nL21udC9vdXRwdXRzL2xhcmF2ZWwtZm9yZ2UtbWNwL3ZpdGVzdC5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tICd2aXRlc3QvY29uZmlnJztcblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKHtcbiAgdGVzdDoge1xuICAgIGVudmlyb25tZW50OiAnbm9kZScsXG4gICAgaW5jbHVkZTogWyd0ZXN0LyoqLyoudGVzdC50cyddLFxuICAgIGNvdmVyYWdlOiB7XG4gICAgICBwcm92aWRlcjogJ3Y4JyxcbiAgICAgIHJlcG9ydGVyOiBbJ3RleHQnLCAnbGNvdiddLFxuICAgICAgaW5jbHVkZTogWydzcmMvKiovKi50cyddLFxuICAgICAgLy8gR2VuZXJhdGVkIGNvZGUgbWlycm9ycyB0aGUgc3BlYyBhbmQgaXMgY292ZXJlZCBieSBjb250cmFjdCB0ZXN0cztcbiAgICAgIC8vIGluZGV4LnRzIGlzIHByb2Nlc3MgYm9vdHN0cmFwIChzdGRpbyArIGV4aXQgY29kZXMpLCBleGVyY2lzZWQgYnkgdGhlXG4gICAgICAvLyBidWlsZCByYXRoZXIgdGhhbiBieSB1bml0IHRlc3RzLlxuICAgICAgZXhjbHVkZTogWydzcmMvZ2VuZXJhdGVkLyoqJywgJ3NyYy9pbmRleC50cycsICdzcmMvdG9vbHMvdHlwZXMudHMnXSxcbiAgICAgIHRocmVzaG9sZHM6IHsgbGluZXM6IDgwLCBmdW5jdGlvbnM6IDgwLCBicmFuY2hlczogNzUsIHN0YXRlbWVudHM6IDgwIH0sXG4gICAgfSxcbiAgfSxcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUEwVyxTQUFTLG9CQUFvQjtBQUV2WSxJQUFPLHdCQUFRLGFBQWE7QUFBQSxFQUMxQixNQUFNO0FBQUEsSUFDSixhQUFhO0FBQUEsSUFDYixTQUFTLENBQUMsbUJBQW1CO0FBQUEsSUFDN0IsVUFBVTtBQUFBLE1BQ1IsVUFBVTtBQUFBLE1BQ1YsVUFBVSxDQUFDLFFBQVEsTUFBTTtBQUFBLE1BQ3pCLFNBQVMsQ0FBQyxhQUFhO0FBQUE7QUFBQTtBQUFBO0FBQUEsTUFJdkIsU0FBUyxDQUFDLG9CQUFvQixnQkFBZ0Isb0JBQW9CO0FBQUEsTUFDbEUsWUFBWSxFQUFFLE9BQU8sSUFBSSxXQUFXLElBQUksVUFBVSxJQUFJLFlBQVksR0FBRztBQUFBLElBQ3ZFO0FBQUEsRUFDRjtBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
