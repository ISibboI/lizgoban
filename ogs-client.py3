import sys, requests, time

def translate_move(move):
	# Handle pass first
	if move[0] == -1 and move[1] == -1:
		return "pass"

	x = move[0]
	y = 19 - move[1]

	# Letter I does not exist in Go notation
	if x >= 8:
		x += 1
	x = chr(ord('A') + x)
	return str(x) + str(y)


if len(sys.argv) != 2:
	sys.exit("Error: Need exactly the game id as argument")

game_id = sys.argv[1]

moves = []

# Give lizgoban some startup time
time.sleep(5)

while True:
	while True:
		try:
			r = requests.get("https://online-go.com/api/v1/games/" + game_id)
			break
		except:
			sys.stderr.write("Error downloading from OGS\n")
			time.sleep(2)
		

	if r.status_code != 200:
		sys.exit("Error: Received status code " + str(r.status_code))

	game_status = r.json()
	new_moves = game_status["gamedata"]["moves"]
	i = 0

	# We search for the first mismatch between moves
	while i < len(new_moves) and i < len(moves):
		if moves[i] != new_moves[i]:
			break
		else:
			i += 1

	# If there was a mismatch within the old moves, then we need to undo
	if i < len(moves):
		print('mimic("undo_ntimes", ' + str(len(moves) - i) + ')')
		moves = moves[:i]

	# Now, moves is a prefix of new_moves, so we only need to add the remaining moves from new_moves
	slept = 0
	while i < len(new_moves):
		print('mimic("play", "' + translate_move(new_moves[i]) + '")')
		time.sleep(10)
		moves.append(new_moves[i])
		i += 1
		slept += 1

	if slept < 1:
		time.sleep(10)