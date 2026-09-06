const app = require('./src/app');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Rehla trip-booking MVP listening on http://localhost:${PORT}`);
});
