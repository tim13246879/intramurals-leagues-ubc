import express from 'express'
const app = express()
const port = 3000

app.get('/', (req, res) => {
  res.send('Hello World!')
})

app.get('/api/v1/leagues', (req, res) => {
  res.send('Get list of all leagues')
})

app.get('/api/v1/leagues/:leagueId/teams', (req, res) => {
  res.send('Get list of all teams within a league')
})

app.get('/api/v1/leagues/:leagueId/teams/:teamId/games', (req, res) => {
  res.send('Get list of all games for a team in a league')
  // option to return only upcoming games or all games
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})