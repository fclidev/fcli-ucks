export function register(ctx) {
  return {
    name: "v",
    desc: "print f version",
    run: () => console.log(ctx.fVersion),
  };
}
export default { register };
